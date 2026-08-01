import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Address, Hex } from 'viem'

import { CardStatus } from '../chain/cardVaultAbi.js'
import { startDaemon, type DaemonHandle } from '../daemon/server.js'
import { HttpApprovalClient } from './approvals.js'
import type {
  GiwaCardMcpContext,
  VaultPublicClient,
  VaultWalletClient,
} from './context.js'
import { McpToolError } from './errors.js'
import {
  createContextFromEnv,
  createGiwaCardMcpServer,
  type McpEnv,
} from './server.js'

/**
 * The MCP server end to end: protocol round-trips, daemon auto-start, and
 * configuration failures.
 *
 * The tool *surface* — and specifically the absence of any approval-resolving
 * tool — is asserted separately in `./surface.test.ts`.
 */

const VAULT = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as Address
const OWNER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address
const SESSION = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address
const MERCHANT = '0x90F79bf6EB2c4f870365E785982E1f101E93b906' as Address
const TOKEN = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0' as Address

let dir: string
const daemons: DaemonHandle[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'giwacard-mcp-'))
})

afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()?.stop()
  rmSync(dir, { recursive: true, force: true })
})

/* -------------------------------------------------------------------------- */
/* Minimal chain stub — reads only, so no RPC is ever contacted.              */
/* -------------------------------------------------------------------------- */

const publicClient: VaultPublicClient = {
  async readContract({ functionName }) {
    switch (functionName) {
      case 'sessionPolicy':
        return {
          capPerCard: 1_000_000n,
          dailyCap: 5_000_000n,
          maxExpiry: 86_400n,
          active: true,
        }
      case 'currentDay':
        return 20_000n
      case 'mintedOnDay':
        return 0n
      case 'balanceOf':
        return 8_000_000n
      case 'escrowedOf':
        return 1_000_000n
      case 'availableBalanceOf':
        return 7_000_000n
      case 'paymentToken':
        return TOKEN
      case 'isMerchantAllowed':
        return true
      case 'getCard':
        return {
          vaultOwner: OWNER,
          agent: SESSION,
          token: TOKEN,
          cap: 0n,
          merchantScope: MERCHANT,
          expiry: 0n,
          status: CardStatus.None,
        }
      default:
        throw new Error(`unmocked read: ${functionName}`)
    }
  },
  async getBalance() {
    return 10n ** 16n
  },
  async waitForTransactionReceipt() {
    return {
      status: 'success' as const,
      transactionHash: `0x${'11'.repeat(32)}` as Hex,
      logs: [],
    }
  },
}

const sessionClient: VaultWalletClient = {
  account: { address: SESSION },
  async writeContract() {
    throw new Error('this suite never writes')
  },
}

function baseContext(
  approvals: GiwaCardMcpContext['approvals'],
): GiwaCardMcpContext {
  return {
    vaultAddress: VAULT,
    vaultOwner: OWNER,
    publicClient,
    sessionClient,
    approvals,
    knownMerchants: [MERCHANT],
    agentLabel: 'server-test',
  }
}

const unusedApprovals: GiwaCardMcpContext['approvals'] = {
  async create() {
    throw new Error('not used')
  },
  async get() {
    throw new Error('not used')
  },
  async markConsumed() {
    throw new Error('not used')
  },
}

/** Connect a real MCP client to the server over a linked in-memory pair. */
async function connectClient(
  context: GiwaCardMcpContext | (() => Promise<GiwaCardMcpContext>),
): Promise<Client> {
  const server = createGiwaCardMcpServer({ context })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await client.connect(clientTransport as never)
  return client
}

/* -------------------------------------------------------------------------- */
/* End-to-end over the protocol                                               */
/* -------------------------------------------------------------------------- */

describe('tools/call over the protocol', () => {
  test('get_balance round-trips through a real MCP client', async () => {
    const client = await connectClient(baseContext(unusedApprovals))
    const result = await client.callTool({ name: 'get_balance', arguments: {} })

    const text = (result.content as { type: string; text: string }[])[0]?.text
    expect(JSON.parse(text ?? '{}')).toMatchObject({
      ok: true,
      available: '7000000',
      escrowed: '1000000',
    })
    expect(result.isError).toBeFalsy()
  })

  test('a bad argument is rejected by the schema before any chain read', async () => {
    const client = await connectClient(baseContext(unusedApprovals))
    const result = await client.callTool({
      name: 'mint_card',
      arguments: { amount: 'not-a-number', merchant: MERCHANT },
    })
    expect(result.isError).toBe(true)
  })

  test('an unresolvable context becomes NOT_CONFIGURED, not a dead server', async () => {
    const client = await connectClient(async () => {
      throw new McpToolError(
        'NOT_CONFIGURED',
        'The giwacard MCP server has no vault address configured.',
      )
    })
    const result = await client.callTool({ name: 'get_balance', arguments: {} })

    const text = (result.content as { type: string; text: string }[])[0]?.text
    expect(JSON.parse(text ?? '{}')).toMatchObject({
      ok: false,
      error: { code: 'NOT_CONFIGURED' },
    })
    expect(result.isError).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* Daemon auto-start (KTD-10)                                                 */
/* -------------------------------------------------------------------------- */

describe('daemon auto-start', () => {
  test('a tool needing the queue starts the daemon and still succeeds', async () => {
    let launched = 0

    const approvals = new HttpApprovalClient({
      daemon: {
        dir,
        port: 0,
        async launch() {
          // Stands in for the detached `giwacard daemon` spawn: it publishes the
          // same `daemon.json` / `daemon-token` files auto-start polls for.
          launched += 1
          daemons.push(await startDaemon({ dir, port: 0 }))
        },
      },
    })

    const client = await connectClient(baseContext(approvals))

    // Over policy (cap 2_000_000 > capPerCard 1_000_000), so this needs the
    // queue — with no daemon running when the call starts.
    const result = await client.callTool({
      name: 'mint_card',
      arguments: {
        amount: '2000000',
        merchant: MERCHANT,
        reason: 'needs the owner',
      },
    })

    const text = (result.content as { type: string; text: string }[])[0]?.text
    const payload = JSON.parse(text ?? '{}') as Record<string, unknown>

    expect(launched).toBe(1)
    expect(payload['ok']).toBe(true)
    expect(payload['status']).toBe('approval_required')
    expect(typeof payload['approval_id']).toBe('string')
    expect(payload['submitted_onchain']).toBe(false)
  })

  test('the queued request is readable back from the daemon', async () => {
    daemons.push(await startDaemon({ dir, port: 0 }))
    const approvals = new HttpApprovalClient({ daemon: { dir } })
    const client = await connectClient(baseContext(approvals))

    const minted = await client.callTool({
      name: 'mint_card',
      arguments: { amount: '2000000', merchant: MERCHANT },
    })
    const approvalId = (
      JSON.parse(
        (minted.content as { text: string }[])[0]?.text ?? '{}',
      ) as Record<string, string>
    )['approval_id']

    // A fresh poll, exactly as a later session would make it.
    const checked = await client.callTool({
      name: 'check_approval_status',
      arguments: { approval_id: approvalId },
    })
    const payload = JSON.parse(
      (checked.content as { text: string }[])[0]?.text ?? '{}',
    ) as Record<string, unknown>

    expect(payload).toMatchObject({
      ok: true,
      approval_id: approvalId,
      status: 'pending',
      amount: '2000000',
      merchant: MERCHANT,
    })
  })

  test('an unknown approval_id returns APPROVAL_NOT_FOUND', async () => {
    daemons.push(await startDaemon({ dir, port: 0 }))
    const approvals = new HttpApprovalClient({ daemon: { dir } })
    const client = await connectClient(baseContext(approvals))

    const result = await client.callTool({
      name: 'check_approval_status',
      arguments: { approval_id: 'nope-not-real' },
    })
    expect(
      JSON.parse((result.content as { text: string }[])[0]?.text ?? '{}'),
    ).toMatchObject({ ok: false, error: { code: 'APPROVAL_NOT_FOUND' } })
  })
})

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

describe('createContextFromEnv', () => {
  test('missing configuration is NOT_CONFIGURED with the variable named', async () => {
    await expect(createContextFromEnv({} as McpEnv)).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
      details: { variable: 'GIWACARD_VAULT_ADDRESS' },
    })
  })

  test('a malformed vault address is rejected before any keystore read', async () => {
    await expect(
      createContextFromEnv({
        GIWACARD_VAULT_ADDRESS: 'not-an-address',
        GIWACARD_VAULT_OWNER: OWNER,
        GIWACARD_PASSPHRASE: 'hunter2',
      }),
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' })
  })

  test('a wrong passphrase never surfaces the underlying keystore error', async () => {
    let error: McpToolError | undefined
    try {
      await createContextFromEnv({
        GIWACARD_VAULT_ADDRESS: VAULT,
        GIWACARD_VAULT_OWNER: OWNER,
        GIWACARD_PASSPHRASE: 'wrong',
        GIWACARD_HOME: dir,
      })
    } catch (caught) {
      error = caught as McpToolError
    }

    expect(error?.code).toBe('NOT_CONFIGURED')
    expect(error?.message).toContain('giwacard init')
    // The message is written for an agent to relay, not a stack to dump.
    expect(error?.message).not.toContain('scrypt')
  })
})
