import { describe, expect, test } from 'bun:test'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { createGiwaCardMcpServer } from './server.js'
import type { GiwaCardMcpContext } from './context.js'

/**
 * The agent-facing tool surface, asserted against a live `tools/list` response
 * rather than against the {@link GIWACARD_TOOLS} array.
 *
 * The distinction is the whole point. Asserting on the array only proves the
 * array is what we think it is; a tool registered by any other path — a future
 * caller passing its own `options.tools`, a helper that appends one, a merge
 * that reintroduces a removed file — would sail past it. Driving a real client
 * over a real transport means the guard sees exactly what an agent sees.
 */

const CONTEXT_NEVER_RESOLVES: () => Promise<GiwaCardMcpContext> = () => {
  throw new Error(
    'context must not be resolved: listing tools may not touch the chain or the keystore',
  )
}

async function listToolNames(
  options: Parameters<typeof createGiwaCardMcpServer>[0] = {
    context: CONTEXT_NEVER_RESOLVES,
  },
): Promise<string[]> {
  const server = createGiwaCardMcpServer(options)
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()

  const client = new Client({ name: 'surface-test', version: '0.0.0' })
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ])

  try {
    const result = await client.listTools()
    return result.tools.map((tool) => tool.name)
  } finally {
    await client.close()
    await server.close()
  }
}

/**
 * Anything that could let an agent settle its own over-policy request.
 *
 * Matched as substrings against the advertised names, so a tool called
 * `resolve_approval`, `approveRequest` or `decide_pending` all trip it.
 */
const FORBIDDEN_NAME_FRAGMENTS = [
  'resolve',
  'approve',
  'approval_decision',
  'decide',
  'deny',
  'grant',
]

const EXPECTED_TOOL_NAMES = [
  'mint_card',
  'get_card_status',
  'cancel_card',
  'get_balance',
  'get_policy',
  'check_approval_status',
]

describe('agent-facing MCP surface', () => {
  test('advertises exactly the six tools R7 specifies', async () => {
    const names = await listToolNames()
    expect([...names].sort()).toEqual([...EXPECTED_TOOL_NAMES].sort())
  })

  test('advertises no tool that can resolve an approval', async () => {
    const names = await listToolNames()

    for (const name of names) {
      for (const fragment of FORBIDDEN_NAME_FRAGMENTS) {
        // check_approval_status only reads; it is the one legitimate name
        // containing "approval", and it must not contain a decision verb.
        if (name === 'check_approval_status' && fragment === 'approval_decision') {
          continue
        }
        expect(name).not.toContain(fragment)
      }
    }
  })

  test('no advertised tool takes a decision-shaped input', async () => {
    const server = createGiwaCardMcpServer({ context: CONTEXT_NEVER_RESOLVES })
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'surface-test', version: '0.0.0' })
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ])

    try {
      const { tools } = await client.listTools()
      for (const tool of tools) {
        const properties = Object.keys(
          (tool.inputSchema as { properties?: Record<string, unknown> })
            .properties ?? {},
        ).map((key) => key.toLowerCase())

        // A `decision`/`approved` argument would smuggle approval authority in
        // through a read-shaped tool.
        expect(properties).not.toContain('decision')
        expect(properties).not.toContain('approved')
        expect(properties).not.toContain('approve')
        expect(properties).not.toContain('resolution')
      }
    } finally {
      await client.close()
      await server.close()
    }
  })

  test('listing tools never resolves the context', async () => {
    // Registration must not touch the keystore or the chain: an MCP host lists
    // tools eagerly at startup, long before the agent has any intent to spend.
    await expect(listToolNames()).resolves.toBeArray()
  })
})
