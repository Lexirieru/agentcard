import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Address, Hex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'

import { CardStatus } from '../chain/cardVaultAbi.js'
import { saveKeystore, type KeystoreOptions } from '../chain/keystore.js'
import { runApproveCommand } from './commands/approve.js'
import { runFaucetCommand } from './commands/faucet.js'
import { runRevokeCommand } from './commands/revoke.js'
import { runStatusCommand } from './commands/status.js'
import { CliError } from './errors.js'
import {
  fakeApproval,
  fakeCard,
  fakePolicy,
  FakeChain,
  FakeDaemon,
  fakeRuntime,
  ScriptedPrompter,
} from './testing.js'
import { WIZARD_STATE_META_KEY } from './wizardState.js'

/**
 * Behavioural tests for the four non-wizard commands.
 *
 * The chain and the daemon are doubles throughout — no RPC, no socket, no
 * spawned daemon. The keystore is real, in a temp directory, because the
 * onboarding path is precisely "what happens when this file is not there" and a
 * mocked keystore would make that test prove nothing.
 */

/** Cheap scrypt: the suite opens a keystore in almost every test. */
const FAST_SCRYPT = { N: 2 ** 10, r: 8, p: 1 }
const PASSPHRASE = 'correct horse battery staple'

const OWNER_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex
const SESSION_KEY =
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba' as Hex

const OWNER = privateKeyToAddress(OWNER_KEY)
const SESSION = privateKeyToAddress(SESSION_KEY)
const VAULT = '0x1111111111111111111111111111111111111111' as Address
const TOKEN = '0x2222222222222222222222222222222222222222' as Address
const MERCHANT = '0x3333333333333333333333333333333333333333' as Address

let dir: string
let keystoreOptions: KeystoreOptions

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'giwacard-cli-'))
  keystoreOptions = { dir, scryptParams: FAST_SCRYPT }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Write a keystore with both keys and a completed wizard record. */
function seedKeystore(
  overrides: { session?: boolean; completed?: string[] } = {},
): void {
  saveKeystore(
    {
      ownerPrivateKey: OWNER_KEY,
      ...(overrides.session === false ? {} : { sessionPrivateKey: SESSION_KEY }),
      meta: {
        [WIZARD_STATE_META_KEY]: {
          version: 1,
          completed: overrides.completed ?? [
            'passphrase',
            'owner-wallet',
            'vault-attach',
            'eth-faucet',
            'gusd-faucet',
            'session-key',
            'policy',
            'agent-config',
          ],
          ownerAddress: OWNER,
          sessionAddress: SESSION,
          vaultAddress: VAULT,
          tokenAddress: TOKEN,
          merchants: [MERCHANT],
        },
      },
    },
    PASSPHRASE,
    keystoreOptions,
  )
}

/** The queued request the approve tests sign, scoped to the demo merchant. */
function approvalForMerchant() {
  return fakeApproval({
    request: {
      agent: SESSION,
      cap: '25000000',
      merchantScope: MERCHANT,
      expiry: '9999999999',
    },
  })
}

/** A chain seeded with the reads `status` and `revoke` need. */
function seededChain(): FakeChain {
  return new FakeChain()
    .setRead('balanceOf', 50_000_000n)
    .setRead('escrowedOf', 5_000_000n)
    .setRead('availableBalanceOf', 45_000_000n)
    .setRead('sessionPolicy', fakePolicy())
    .setRead('lastCardId', 0n)
    .setRead('paymentToken', TOKEN)
    .setRead('faucetAvailableAt', 0n)
}

function runtimeWith(options: {
  chain?: FakeChain
  daemon?: FakeDaemon
  prompter?: ScriptedPrompter
  now?: () => number
}) {
  return fakeRuntime({
    env: { GIWACARD_PASSPHRASE: PASSPHRASE },
    keystoreOptions,
    ...(options.chain !== undefined ? { chain: options.chain } : {}),
    ...(options.daemon !== undefined ? { daemon: options.daemon } : {}),
    ...(options.prompter !== undefined ? { prompter: options.prompter } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  })
}

/* ========================================================================== */
/* No keystore                                                                */
/* ========================================================================== */

describe('a command on a machine with no keystore', () => {
  const commands: [string, (runtime: never) => Promise<number>][] = [
    ['status', (runtime) => runStatusCommand(runtime)],
    ['approve', (runtime) => runApproveCommand(runtime)],
    ['faucet', (runtime) => runFaucetCommand(runtime)],
    [
      'revoke card',
      (runtime) => runRevokeCommand(runtime, { subject: 'card', target: '1' }),
    ],
  ]

  for (const [name, run] of commands) {
    test(`\`giwacard ${name}\` points at \`giwacard init\``, async () => {
      const runtime = runtimeWith({ chain: seededChain() })
      const error = (await run(runtime as never).catch(
        (caught: unknown) => caught,
      )) as CliError

      expect(error).toBeInstanceOf(CliError)
      expect(error.code).toBe('NO_KEYSTORE')
      expect(error.message).toContain('not set up on this machine yet')
      // The message names where it looked, so a $GIWACARD_HOME mix-up is visible.
      expect(error.message).toContain(dir)
      expect(error.hint).toContain('giwacard init')
    })
  }

  test('the onboarding error never leaks a stack', async () => {
    const runtime = runtimeWith({ chain: seededChain() })
    const error = (await runStatusCommand(runtime).catch(
      (caught: unknown) => caught,
    )) as CliError
    expect(error.message).not.toContain('    at ')
  })
})

/* ========================================================================== */
/* faucet                                                                     */
/* ========================================================================== */

describe('giwacard faucet', () => {
  test('a 24h cooldown produces a specific message, not a raw failure', async () => {
    seedKeystore()
    const nowMs = 1_700_000_000_000
    const nowSeconds = BigInt(Math.floor(nowMs / 1000))
    // Claimed 6 hours ago, so it unlocks in 18.
    const availableAt = nowSeconds + 18n * 3600n

    const chain = seededChain().setRead('faucetAvailableAt', availableAt)
    const runtime = runtimeWith({ chain, now: () => nowMs })

    const error = (await runFaucetCommand(runtime).catch(
      (caught: unknown) => caught,
    )) as CliError

    expect(error).toBeInstanceOf(CliError)
    expect(error.code).toBe('FAUCET_COOLDOWN')
    expect(error.message).toContain('still on cooldown')
    expect(error.message).toContain(OWNER)
    // Names *when* it unlocks and how long that is, not just "try later".
    expect(error.message).toContain('18h 0m from now')
    expect(error.message).toMatch(/unlocks at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/)
    expect(error.hint).toContain('100 gUSD per address per 24 hours')

    // Nothing was submitted: the user does not pay gas to be told no.
    expect(chain.writes).toHaveLength(0)
  })

  test('claims when the cooldown has elapsed', async () => {
    seedKeystore()
    const chain = seededChain()
      .setRead('faucetAvailableAt', 0n)
      .setRead(`balanceOf:${OWNER.toLowerCase()}`, 0n)
    const runtime = runtimeWith({ chain })

    // `balanceOf` is read on both the vault and the token; the token read wins
    // via the keyed lookup, so seed the post-claim value the same way.
    chain.setRead(`balanceOf:${OWNER.toLowerCase()}`, 100_000_000n)

    const code = await runFaucetCommand(runtime, { yes: true })
    expect(code).toBe(0)
    expect(chain.writesTo('claimFaucet')).toHaveLength(1)
    expect(chain.writesTo('claimFaucet')[0]?.from).toBe(OWNER)
    expect(runtime.output.stdout).toContain('Next claim')
  })

  test('a cooldown that unlocks in minutes is still reported precisely', async () => {
    seedKeystore()
    const nowMs = 1_700_000_000_000
    const nowSeconds = BigInt(Math.floor(nowMs / 1000))
    const chain = seededChain().setRead('faucetAvailableAt', nowSeconds + 90n)
    const runtime = runtimeWith({ chain, now: () => nowMs })

    const error = (await runFaucetCommand(runtime).catch(
      (caught: unknown) => caught,
    )) as CliError
    expect(error.message).toContain('1m 30s from now')
  })
})

/* ========================================================================== */
/* revoke                                                                     */
/* ========================================================================== */

describe('giwacard revoke — key and card are different objects', () => {
  test('`revoke key` deactivates the key and leaves its active card alive', async () => {
    seedKeystore()
    const chain = seededChain()
      .setRead('lastCardId', 2n)
      .setRead(
        'getCard:1',
        fakeCard({ vaultOwner: OWNER, agent: SESSION, cap: 7_000_000n }),
      )
      .setRead(
        'getCard:2',
        fakeCard({
          vaultOwner: OWNER,
          agent: SESSION,
          status: CardStatus.Used,
        }),
      )
    const runtime = runtimeWith({ chain })

    const code = await runRevokeCommand(runtime, {
      subject: 'key',
      target: SESSION,
      yes: true,
    })
    expect(code).toBe(0)

    // Exactly one write, and it is the session-key revocation.
    expect(chain.writes).toHaveLength(1)
    expect(chain.writesTo('revokeSessionKey')).toHaveLength(1)
    expect(chain.writesTo('revokeSessionKey')[0]?.args).toEqual([SESSION])
    // Critically: no card was cancelled.
    expect(chain.writesTo('cancelCard')).toHaveLength(0)

    const out = runtime.output.stdout
    expect(out).toContain('stay ACTIVE')
    // The surviving card is named, with the command that would cancel it.
    expect(out).toContain('STILL ACTIVE')
    expect(out).toContain('giwacard revoke card 1')
    // The already-used card is not offered for cancellation.
    expect(out).not.toContain('giwacard revoke card 2')
  })

  test('`revoke card` cancels one card and leaves the session key active', async () => {
    seedKeystore()
    const chain = seededChain().setRead(
      'getCard:1',
      fakeCard({ vaultOwner: OWNER, agent: SESSION, cap: 7_000_000n }),
    )
    const runtime = runtimeWith({ chain })

    const code = await runRevokeCommand(runtime, {
      subject: 'card',
      target: '1',
      yes: true,
    })
    expect(code).toBe(0)

    expect(chain.writes).toHaveLength(1)
    expect(chain.writesTo('cancelCard')).toHaveLength(1)
    expect(chain.writesTo('cancelCard')[0]?.args).toEqual([1n])
    // Critically: the session key was not revoked.
    expect(chain.writesTo('revokeSessionKey')).toHaveLength(0)

    const out = runtime.output.stdout
    expect(out).toContain('stays active and can mint again')
    // And it tells the user the other command, in case that is what they meant.
    expect(out).toContain(`giwacard revoke key ${SESSION}`)
  })

  test('`revoke key` on a key with no cards says so rather than implying danger', async () => {
    seedKeystore()
    const chain = seededChain().setRead('lastCardId', 0n)
    const runtime = runtimeWith({ chain })

    await runRevokeCommand(runtime, {
      subject: 'key',
      target: SESSION,
      yes: true,
    })
    expect(runtime.output.stdout).toContain('no active cards, so nothing survives it')
  })

  test('an already-inactive key sends nothing and still lists live cards', async () => {
    seedKeystore()
    const chain = seededChain()
      .setRead('sessionPolicy', fakePolicy({ active: false }))
      .setRead('lastCardId', 1n)
      .setRead('getCard:1', fakeCard({ vaultOwner: OWNER, agent: SESSION }))
    const runtime = runtimeWith({ chain })

    const code = await runRevokeCommand(runtime, {
      subject: 'key',
      target: SESSION,
      yes: true,
    })
    expect(code).toBe(0)
    expect(chain.writes).toHaveLength(0)
    expect(runtime.output.stdout).toContain('already inactive')
    expect(runtime.output.stdout).toContain('revoking a key never cancels them')
  })

  test('an already-cancelled card sends nothing', async () => {
    seedKeystore()
    const chain = seededChain().setRead(
      'getCard:1',
      fakeCard({ vaultOwner: OWNER, agent: SESSION, status: CardStatus.Revoked }),
    )
    const runtime = runtimeWith({ chain })

    const code = await runRevokeCommand(runtime, {
      subject: 'card',
      target: '1',
      yes: true,
    })
    expect(code).toBe(0)
    expect(chain.writes).toHaveLength(0)
    expect(runtime.output.stdout).toContain('already revoked')
  })

  test('a never-minted card id is NOT_FOUND, not a revert', async () => {
    seedKeystore()
    const chain = seededChain().setRead(
      'getCard:9',
      fakeCard({ status: CardStatus.None }),
    )
    const runtime = runtimeWith({ chain })

    const error = (await runRevokeCommand(runtime, {
      subject: 'card',
      target: '9',
      yes: true,
    }).catch((caught: unknown) => caught)) as CliError
    expect(error.code).toBe('NOT_FOUND')
    expect(chain.writes).toHaveLength(0)
  })

  test('the two forms cannot be confused: argv errors spell both out', async () => {
    const runtime = runtimeWith({ chain: seededChain() })

    const bare = (await runRevokeCommand(runtime).catch(
      (caught: unknown) => caught,
    )) as CliError
    expect(bare.code).toBe('INVALID_ARGUMENT')
    expect(bare.message).toContain('giwacard revoke key <address>')
    expect(bare.message).toContain('giwacard revoke card <id>')
    expect(bare.message).toContain('stay ACTIVE')

    // An address where an id belongs suggests the other form by name.
    const swapped = (await runRevokeCommand(runtime, {
      subject: 'card',
      target: SESSION,
    }).catch((caught: unknown) => caught)) as CliError
    expect(swapped.message).toContain(`giwacard revoke key ${SESSION}`)

    // And the reverse.
    const swappedBack = (await runRevokeCommand(runtime, {
      subject: 'key',
      target: '7',
    }).catch((caught: unknown) => caught)) as CliError
    expect(swappedBack.message).toContain('giwacard revoke card 7')
  })
})

/* ========================================================================== */
/* status                                                                     */
/* ========================================================================== */

describe('giwacard status', () => {
  test('an empty vault renders every section, never a blank screen', async () => {
    seedKeystore()
    const runtime = runtimeWith({
      chain: seededChain()
        .setRead('balanceOf', 0n)
        .setRead('escrowedOf', 0n)
        .setRead('availableBalanceOf', 0n)
        .setRead('lastCardId', 0n),
      daemon: new FakeDaemon([]),
    })

    const code = await runStatusCommand(runtime)
    expect(code).toBe(0)

    const out = runtime.output.stdout
    expect(out).toContain('Balance')
    expect(out).toContain('Escrowed')
    expect(out).toContain('Available')
    expect(out).toContain('No active cards')
    expect(out).toContain('No pending approvals')
    // Both empty states point at what would create a row.
    expect(out).toContain('mint_card')
    expect(out).toContain('Over-policy card requests')
  })

  test('lists active cards and pending approvals when there are some', async () => {
    seedKeystore()
    const runtime = runtimeWith({
      chain: seededChain()
        .setRead('lastCardId', 1n)
        .setRead(
          'getCard:1',
          fakeCard({ vaultOwner: OWNER, agent: SESSION, cap: 7_500_000n }),
        ),
      daemon: new FakeDaemon([fakeApproval()]),
    })

    await runStatusCommand(runtime)
    const out = runtime.output.stdout
    expect(out).toContain('Active cards (1)')
    expect(out).toContain('7.5')
    expect(out).toContain('Pending approvals (1)')
    expect(out).toContain('giwacard approve')
  })

  test('a dead daemon costs the approval list, not the balance', async () => {
    seedKeystore()
    const runtime = runtimeWith({
      chain: seededChain(),
      daemon: new FakeDaemon().failWith(new Error('daemon is down')),
    })

    const code = await runStatusCommand(runtime)
    expect(code).toBe(0)
    expect(runtime.output.stdout).toContain('Balance')
    expect(runtime.output.stdout).toContain('Could not reach the local approval daemon')
    expect(runtime.output.stdout).toContain('giwacard daemon')
  })

  test('a revoked session key is called out, not silently shown as normal', async () => {
    seedKeystore()
    const runtime = runtimeWith({
      chain: seededChain().setRead('sessionPolicy', fakePolicy({ active: false })),
    })
    await runStatusCommand(runtime)
    expect(runtime.output.stdout).toContain('REVOKED')
  })

  test('a keystore with no session key says so instead of rendering an empty panel', async () => {
    seedKeystore({ session: false })
    const runtime = runtimeWith({ chain: seededChain() })
    await runStatusCommand(runtime)
    expect(runtime.output.stdout).toContain('No session key yet')
  })

  test('--gas prints one row per submitting address (KTD-6)', async () => {
    seedKeystore()
    const chain = seededChain()
    chain.setBalance(OWNER, 10n ** 15n).setBalance(SESSION, 0n)
    const runtime = runtimeWith({ chain })

    await runStatusCommand(runtime, { gas: true })
    const out = runtime.output.stdout
    expect(out).toContain('Gas budget by submitting address')
    expect(out).toContain('owner wallet')
    expect(out).toContain('session key')
    expect(out).toContain('TOP UP')
  })
})

/* ========================================================================== */
/* approve                                                                    */
/* ========================================================================== */

describe('giwacard approve', () => {
  test('an empty queue is a sentence, not a blank screen', async () => {
    seedKeystore()
    const runtime = runtimeWith({
      chain: seededChain(),
      daemon: new FakeDaemon([]),
    })

    const code = await runApproveCommand(runtime)
    expect(code).toBe(0)
    expect(runtime.output.stdout).toContain('No approvals are waiting on you')
    expect(runtime.output.stdout).toContain('giwacard status')
  })

  test('an already-resolved request reports its outcome instead of re-signing', async () => {
    seedKeystore()
    const daemon = new FakeDaemon([
      fakeApproval({ id: 'req-9', status: 'approved', cardId: '42', terminal: true }),
    ])
    const runtime = runtimeWith({ chain: seededChain(), daemon })

    const code = await runApproveCommand(runtime, { id: 'req-9' })
    expect(code).toBe(0)
    expect(runtime.output.stdout).toContain('already approved')
    expect(runtime.output.stdout).toContain('minted card 42')
    expect(daemon.resolved).toHaveLength(0)
  })

  test('approving signs EIP-712 and posts the signature with the exact terms', async () => {
    seedKeystore()
    const daemon = new FakeDaemon([approvalForMerchant()])
    const prompter = new ScriptedPrompter([
      { kind: 'select', value: 'approve' },
      { kind: 'confirm', value: true },
    ])
    const runtime = runtimeWith({ chain: seededChain(), daemon, prompter })

    const code = await runApproveCommand(runtime, { id: 'req-1' })
    expect(code).toBe(0)

    expect(daemon.resolved).toHaveLength(1)
    const resolved = daemon.resolved[0]
    expect(resolved?.input.decision).toBe('approve')
    expect(resolved?.input.ownerSignature).toMatch(/^0x[0-9a-f]{130}$/)
    expect(resolved?.input.ownerAddress).toBe(OWNER)

    // The daemon stores the terms that were signed, not the raw request.
    const approved = resolved?.input.approvedRequest as Record<string, unknown>
    expect(approved['vaultOwner']).toBe(OWNER)
    expect(approved['cap']).toBe('25000000')
    expect(approved['merchantScope']).toBe(MERCHANT)
    expect(approved['approvalId']).toMatch(/^0x[0-9a-f]{64}$/)

    expect(runtime.output.stdout).toContain('Approved')
    expect(runtime.output.stdout).toContain('the agent pays the gas')
  })

  test('denying records the decision and carries no signature', async () => {
    seedKeystore()
    const daemon = new FakeDaemon([fakeApproval()])
    const prompter = new ScriptedPrompter([
      { kind: 'select', value: 'deny' },
      { kind: 'text', value: 'too expensive' },
    ])
    const runtime = runtimeWith({ chain: seededChain(), daemon, prompter })

    await runApproveCommand(runtime, { id: 'req-1' })
    expect(daemon.resolved[0]?.input.decision).toBe('deny')
    // A denial carries no signature field at all, which is what the daemon
    // rejects a signed denial on.
    expect(daemon.resolved[0]?.input.ownerSignature).toBeUndefined()
    expect(daemon.resolved[0]?.input.note).toBe('too expensive')
    expect(runtime.output.stdout).toContain('terminal refusal')
  })

  test('skipping leaves it pending and signs nothing', async () => {
    seedKeystore()
    const daemon = new FakeDaemon([fakeApproval()])
    const prompter = new ScriptedPrompter([{ kind: 'select', value: 'skip' }])
    const runtime = runtimeWith({ chain: seededChain(), daemon, prompter })

    await runApproveCommand(runtime, { id: 'req-1' })
    expect(daemon.resolved).toHaveLength(0)
    expect(runtime.output.stdout).toContain('Left pending')
  })

  test('a request with unreadable terms is refused rather than signed blind', async () => {
    seedKeystore()
    const daemon = new FakeDaemon([
      fakeApproval({ id: 'bad', request: { cap: 'not-a-number' } }),
    ])
    const runtime = runtimeWith({ chain: seededChain(), daemon })

    const error = (await runApproveCommand(runtime, { id: 'bad' }).catch(
      (caught: unknown) => caught,
    )) as CliError
    expect(error).toBeInstanceOf(CliError)
    expect(error.code).toBe('INVALID_ARGUMENT')
    expect(error.message).toContain('nothing safe to sign')
    expect(daemon.resolved).toHaveLength(0)
  })

  test('the same request always derives the same approval id', async () => {
    seedKeystore()
    const daemon = new FakeDaemon([fakeApproval()])
    const ids: string[] = []

    for (let round = 0; round < 2; round++) {
      const fresh = new FakeDaemon([fakeApproval()])
      const runtime = runtimeWith({
        chain: seededChain(),
        daemon: fresh,
        prompter: new ScriptedPrompter([
          { kind: 'select', value: 'approve' },
          { kind: 'confirm', value: true },
        ]),
      })
      await runApproveCommand(runtime, { id: 'req-1' })
      ids.push(
        (fresh.resolved[0]?.input.approvedRequest as Record<string, string>)[
          'approvalId'
        ] as string,
      )
    }

    // A second approval of the same request must not mint a second card, so the
    // vault's replay nonce has to be stable.
    expect(ids[0]).toBe(ids[1] as string)
    expect(daemon.resolved).toHaveLength(0)
  })
})

