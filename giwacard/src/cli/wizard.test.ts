import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Address, Hex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'

import {
  loadKeystore,
  saveKeystore,
  type KeystoreOptions,
} from '../chain/keystore.js'
import { MCP_SERVER_ENTRY_NAME, MCP_SERVERS_KEY } from './agentConfig.js'
import { runInitCommand } from './commands/init.js'
import { CliError } from './errors.js'
import {
  fakePolicy,
  FakeChain,
  fakeRuntime,
  memoryAgentConfigFs,
  ScriptedPrompter,
} from './testing.js'
import {
  readWizardState,
  WIZARD_STATE_META_KEY,
  WIZARD_STEPS,
  type WizardStepId,
} from './wizardState.js'

/**
 * The wizard's resume behaviour, exercised end to end through
 * {@link runInitCommand} with a real (temp) keystore and doubles for everything
 * else.
 *
 * Resume is asserted two ways, and both matter. The *positive* assertion is that
 * the remaining steps run and the state ends complete. The *negative* one — that
 * a finished step's transaction is never re-sent and its question never
 * re-asked — is the one that actually proves resumption, because a wizard that
 * silently redid everything would still finish "successfully".
 */

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
  dir = mkdtempSync(join(tmpdir(), 'giwacard-wizard-'))
  keystoreOptions = { dir, scryptParams: FAST_SCRYPT }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A chain with every read the wizard performs already seeded. */
function wizardChain(): FakeChain {
  return new FakeChain()
    .setRead('paymentToken', TOKEN)
    .setRead('faucetAvailableAt', 0n)
    .setRead('balanceOf', 100_000_000n)
    .setRead('sessionPolicy', fakePolicy())
}

/** Write a keystore that stopped partway through the wizard. */
function seedInterrupted(completed: WizardStepId[]): void {
  saveKeystore(
    {
      ownerPrivateKey: OWNER_KEY,
      ...(completed.includes('session-key')
        ? { sessionPrivateKey: SESSION_KEY }
        : {}),
      meta: {
        [WIZARD_STATE_META_KEY]: {
          version: 1,
          completed,
          ownerAddress: OWNER,
          vaultAddress: VAULT,
          tokenAddress: TOKEN,
        },
      },
    },
    PASSPHRASE,
    keystoreOptions,
  )
}

function wizardRuntime(options: {
  chain?: FakeChain
  prompter?: ScriptedPrompter
  agentFs?: ReturnType<typeof memoryAgentConfigFs>
} = {}) {
  return fakeRuntime({
    env: {
      GIWACARD_PASSPHRASE: PASSPHRASE,
      GIWACARD_VAULT_ADDRESS: VAULT,
      GIWACARD_GUSD_ADDRESS: TOKEN,
      GIWACARD_MERCHANT_ADDRESS: MERCHANT,
    },
    keystoreOptions,
    chain: options.chain ?? wizardChain(),
    prompter: options.prompter ?? new ScriptedPrompter(),
    agentConfig: {
      fs: options.agentFs ?? memoryAgentConfigFs(),
      home: '/home/test',
      platform: 'linux',
    },
  })
}

/** Read the persisted wizard state back out of the temp keystore. */
function persistedState() {
  return readWizardState(loadKeystore(PASSPHRASE, keystoreOptions))
}

/* ========================================================================== */

describe('resuming an interrupted wizard', () => {
  test('picks up at the first unfinished step and finishes the rest', async () => {
    seedInterrupted([
      'passphrase',
      'owner-wallet',
      'vault-attach',
      'eth-faucet',
      'gusd-faucet',
    ])

    const chain = wizardChain()
    const agentFs = memoryAgentConfigFs()
    const runtime = wizardRuntime({ chain, agentFs })

    const code = await runInitCommand(runtime, { yes: true })
    expect(code).toBe(0)

    const out = runtime.output.stdout
    // It announces where it is resuming from, so the run is not mistaken for a
    // fresh one.
    expect(out).toContain('Resuming at step 6 of 8')
    expect(out).toContain('Session key and gas budget')
    expect(out).toContain('5 step(s) already done')

    // The finished steps are reported as skipped, not silently repeated.
    expect(out).toContain('Owner wallet — already done')
    expect(out).toContain('Attach to the vault — already done')
    expect(out).toContain('Claim gUSD — already done')

    // The one transaction the remaining steps owe is the policy registration.
    expect(chain.writesTo('registerSessionKey')).toHaveLength(1)
    // And emphatically NOT the faucet claim from the step already done.
    expect(chain.writesTo('claimFaucet')).toHaveLength(0)

    const state = persistedState()
    expect(state.completed.sort()).toEqual([...WIZARD_STEPS].sort())
    expect(state.sessionAddress).toBeDefined()
    expect(state.merchants).toEqual([MERCHANT])

    // The agent host config was written with the merged entry.
    const config = JSON.parse(
      agentFs.files['/home/test/.config/Claude/claude_desktop_config.json'] as string,
    ) as Record<string, Record<string, unknown>>
    expect(config[MCP_SERVERS_KEY]?.[MCP_SERVER_ENTRY_NAME]).toBeDefined()
  })

  test('a wizard interrupted before the policy re-runs only the policy step onward', async () => {
    seedInterrupted([
      'passphrase',
      'owner-wallet',
      'vault-attach',
      'eth-faucet',
      'gusd-faucet',
      'session-key',
    ])

    const chain = wizardChain()
    const runtime = wizardRuntime({ chain })
    await runInitCommand(runtime, { yes: true })

    expect(runtime.output.stdout).toContain('Resuming at step 7 of 8')
    expect(chain.writesTo('registerSessionKey')).toHaveLength(1)
    // The pre-existing session key is reused, not regenerated.
    expect(persistedState().sessionAddress).toBe(SESSION)
    expect(
      loadKeystore(PASSPHRASE, keystoreOptions).sessionPrivateKey,
    ).toBe(SESSION_KEY)
  })

  test('re-running a completed wizard sends nothing and asks nothing', async () => {
    seedInterrupted([...WIZARD_STEPS])
    const chain = wizardChain()
    const prompter = new ScriptedPrompter([])
    const runtime = wizardRuntime({ chain, prompter })

    const code = await runInitCommand(runtime, { yes: true })
    expect(code).toBe(0)
    expect(chain.writes).toHaveLength(0)
    expect(prompter.asked).toHaveLength(0)
    expect(runtime.output.stdout).toContain('Setup complete')
  })

  test('--fresh ignores recorded progress and runs the steps again', async () => {
    seedInterrupted([...WIZARD_STEPS])
    const chain = wizardChain()
    const runtime = wizardRuntime({ chain })

    await runInitCommand(runtime, { yes: true, fresh: true })
    // The policy is re-registered, which is the observable proof that the
    // recorded completion was ignored.
    expect(chain.writesTo('registerSessionKey')).toHaveLength(1)
    expect(chain.writesTo('claimFaucet')).toHaveLength(1)
  })

  test('progress survives a step that throws halfway through', async () => {
    seedInterrupted(['passphrase', 'owner-wallet', 'vault-attach', 'eth-faucet'])

    // Make the gUSD claim fail the way a reverted transaction would.
    const chain = wizardChain()
    chain.state.receipt = { ...chain.state.receipt, status: 'reverted' }
    const runtime = wizardRuntime({ chain })

    await expect(runInitCommand(runtime, { yes: true })).rejects.toBeInstanceOf(
      CliError,
    )

    // The four steps that had already succeeded are still recorded, so the next
    // run resumes at the failure rather than at the beginning.
    const state = persistedState()
    expect(state.completed).toEqual([
      'passphrase',
      'owner-wallet',
      'vault-attach',
      'eth-faucet',
    ])
  })

  test('the gUSD cooldown does not block setup — it is reported and skipped', async () => {
    seedInterrupted(['passphrase', 'owner-wallet', 'vault-attach', 'eth-faucet'])

    const nowMs = 1_700_000_000_000
    const availableAt = BigInt(Math.floor(nowMs / 1000)) + 3600n
    const chain = wizardChain().setRead('faucetAvailableAt', availableAt)
    const prompter = new ScriptedPrompter([])
    const runtime = fakeRuntime({
      env: {
        GIWACARD_PASSPHRASE: PASSPHRASE,
        GIWACARD_VAULT_ADDRESS: VAULT,
        GIWACARD_GUSD_ADDRESS: TOKEN,
        GIWACARD_MERCHANT_ADDRESS: MERCHANT,
      },
      keystoreOptions,
      chain,
      prompter,
      now: () => nowMs,
      agentConfig: {
        fs: memoryAgentConfigFs(),
        home: '/home/test',
        platform: 'linux',
      },
    })

    const code = await runInitCommand(runtime, { yes: true })
    expect(code).toBe(0)
    // The cooldown was explained, by the same specific message `giwacard
    // faucet` would print.
    expect(prompter.logged.join('\n')).toContain('still on cooldown')
    expect(prompter.logged.join('\n')).toContain('1h 0m from now')
    expect(chain.writesTo('claimFaucet')).toHaveLength(0)
    // And setup carried on to completion.
    expect(persistedState().completed.sort()).toEqual([...WIZARD_STEPS].sort())
  })
})

describe('the wizard never deploys (KTD-17)', () => {
  test('it attaches to the configured vault and reads the token from it', async () => {
    seedInterrupted(['passphrase', 'owner-wallet'])
    const chain = wizardChain()
    const runtime = wizardRuntime({ chain })

    await runInitCommand(runtime, { yes: true })

    expect(runtime.output.stdout).toContain('Attached')
    expect(runtime.output.stdout).toContain(VAULT)
    // Every write goes to a pre-existing address; nothing is deployed.
    for (const write of chain.writes) {
      expect([VAULT, TOKEN]).toContain(write.address)
    }
    expect(persistedState().vaultAddress).toBe(VAULT)
    expect(persistedState().tokenAddress).toBe(TOKEN)
  })
})

describe('the policy step seeds the merchant allowlist (F2 depends on it)', () => {
  test('the demo merchant is passed to registerSessionKey', async () => {
    seedInterrupted([
      'passphrase',
      'owner-wallet',
      'vault-attach',
      'eth-faucet',
      'gusd-faucet',
      'session-key',
    ])
    const chain = wizardChain()
    const runtime = wizardRuntime({ chain })

    await runInitCommand(runtime, { yes: true })

    const write = chain.writesTo('registerSessionKey')[0]
    expect(write).toBeDefined()
    // args: [sessionKey, capPerCard, dailyCap, maxExpiry, merchants]
    expect(write?.args[0]).toBe(SESSION)
    expect(write?.args[4]).toEqual([MERCHANT])
  })

  test('with no merchant configured it asks rather than registering an empty allowlist', async () => {
    seedInterrupted([
      'passphrase',
      'owner-wallet',
      'vault-attach',
      'eth-faucet',
      'gusd-faucet',
      'session-key',
    ])
    const chain = wizardChain()
    const prompter = new ScriptedPrompter([{ kind: 'text', value: MERCHANT }])
    const runtime = fakeRuntime({
      env: {
        GIWACARD_PASSPHRASE: PASSPHRASE,
        GIWACARD_VAULT_ADDRESS: VAULT,
        GIWACARD_GUSD_ADDRESS: TOKEN,
      },
      keystoreOptions,
      chain,
      prompter,
      agentConfig: {
        fs: memoryAgentConfigFs(),
        home: '/home/test',
        platform: 'linux',
      },
    })

    await runInitCommand(runtime, { yes: true })

    expect(prompter.questions.join('\n')).toContain('Demo merchant address')
    expect(runtime.output.stdout).toContain('deny-by-default')
    expect(chain.writesTo('registerSessionKey')[0]?.args[4]).toEqual([MERCHANT])
  })
})

describe('the agent host config', () => {
  test('does not store the passphrase and says how to supply it', async () => {
    seedInterrupted([...WIZARD_STEPS].slice(0, 7) as WizardStepId[])
    const agentFs = memoryAgentConfigFs()
    const runtime = wizardRuntime({ agentFs })

    await runInitCommand(runtime, { yes: true })

    const path = '/home/test/.config/Claude/claude_desktop_config.json'
    const written = agentFs.files[path] as string
    expect(written).not.toContain(PASSPHRASE)
    expect(written).toContain(VAULT)
    expect(runtime.output.stdout).toContain('NOT stored')
    expect(runtime.output.stdout).toContain('GIWACARD_PASSPHRASE')
  })

  test('--host selects the file to write', async () => {
    seedInterrupted([...WIZARD_STEPS].slice(0, 7) as WizardStepId[])
    const agentFs = memoryAgentConfigFs()
    const runtime = wizardRuntime({ agentFs })

    await runInitCommand(runtime, { yes: true, host: 'cursor' })
    expect(Object.keys(agentFs.files)).toEqual(['/home/test/.cursor/mcp.json'])
  })

  test('an unknown host is refused by name', async () => {
    seedInterrupted([...WIZARD_STEPS].slice(0, 7) as WizardStepId[])
    const runtime = wizardRuntime()

    const error = (await runInitCommand(runtime, {
      yes: true,
      host: 'emacs',
    }).catch((caught: unknown) => caught)) as CliError
    expect(error.code).toBe('INVALID_ARGUMENT')
    expect(error.hint).toContain('claude, cursor, gemini')
  })
})
