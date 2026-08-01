import { describe, expect, test } from 'bun:test'
import type { Address } from 'viem'

import type { KeystoreData } from '../chain/keystore.js'
import {
  completeStep,
  describeResume,
  emptyWizardState,
  isResumable,
  isStepComplete,
  nextStep,
  readWizardState,
  remainingSteps,
  WIZARD_STATE_META_KEY,
  WIZARD_STEPS,
  writeWizardState,
} from './wizardState.js'

const OWNER = '0x1111111111111111111111111111111111111111' as Address
const VAULT = '0x2222222222222222222222222222222222222222' as Address

describe('wizard state round-trip', () => {
  test('an empty keystore has nothing done', () => {
    const state = readWizardState({})
    expect(state.completed).toEqual([])
    expect(nextStep(state)).toBe('passphrase')
    expect(isResumable(state)).toBe(false)
  })

  test('survives a write/read cycle through the keystore payload', () => {
    let data: KeystoreData = { ownerPrivateKey: '0xdead' }
    const state = completeStep(
      completeStep(emptyWizardState(), 'passphrase'),
      'owner-wallet',
      { ownerAddress: OWNER },
    )
    data = writeWizardState(data, state)

    const read = readWizardState(data)
    expect(read.completed).toEqual(['passphrase', 'owner-wallet'])
    expect(read.ownerAddress).toBe(OWNER)
    // The write must not disturb the keys sitting next to it.
    expect(data.ownerPrivateKey).toBe('0xdead')
  })

  test('other meta keys are preserved', () => {
    const data = writeWizardState(
      { meta: { somethingElse: 42 } },
      emptyWizardState(),
    )
    expect(data.meta?.['somethingElse']).toBe(42)
    expect(data.meta?.[WIZARD_STATE_META_KEY]).toBeDefined()
  })

  test('completing a step twice does not duplicate it', () => {
    const once = completeStep(emptyWizardState(), 'passphrase')
    const twice = completeStep(once, 'passphrase')
    expect(twice.completed).toEqual(['passphrase'])
  })
})

describe('resume from an interrupted step', () => {
  test('resumes at the first unfinished step', () => {
    const state = readWizardState({
      meta: {
        [WIZARD_STATE_META_KEY]: {
          version: 1,
          completed: ['passphrase', 'owner-wallet', 'vault-attach'],
          ownerAddress: OWNER,
          vaultAddress: VAULT,
        },
      },
    })

    expect(nextStep(state)).toBe('eth-faucet')
    expect(isResumable(state)).toBe(true)
    expect(isStepComplete(state, 'vault-attach')).toBe(true)
    expect(isStepComplete(state, 'eth-faucet')).toBe(false)
    expect(remainingSteps(state)).toEqual([
      'eth-faucet',
      'gusd-faucet',
      'session-key',
      'policy',
      'agent-config',
    ])
  })

  test('resumes at the earliest GAP, not after the latest recorded step', () => {
    // A run that somehow recorded a later step first must not skip the hole:
    // silently jumping past `eth-faucet` would leave the wallet unfunded and
    // fail at the next transaction with an unrelated message.
    const state = readWizardState({
      meta: {
        [WIZARD_STATE_META_KEY]: {
          version: 1,
          completed: ['passphrase', 'owner-wallet', 'gusd-faucet'],
        },
      },
    })
    expect(nextStep(state)).toBe('vault-attach')
  })

  test('the resume line names the step and the position', () => {
    const state = completeStep(
      completeStep(emptyWizardState(), 'passphrase'),
      'owner-wallet',
    )
    const line = describeResume(state)
    expect(line).toContain('step 3 of 8')
    expect(line).toContain('Attach to the vault')
    expect(line).toContain('2 step(s) already done')
  })

  test('a finished wizard has no next step', () => {
    let state = emptyWizardState()
    for (const step of WIZARD_STEPS) state = completeStep(state, step)
    expect(nextStep(state)).toBeNull()
    expect(isResumable(state)).toBe(false)
    expect(describeResume(state)).toContain('already complete')
  })
})

describe('unreadable state is treated as "start over", never as progress', () => {
  test('a future schema version is discarded', () => {
    const state = readWizardState({
      meta: {
        [WIZARD_STATE_META_KEY]: { version: 99, completed: WIZARD_STEPS },
      },
    })
    expect(state.completed).toEqual([])
  })

  test('unknown step names are dropped', () => {
    const state = readWizardState({
      meta: {
        [WIZARD_STATE_META_KEY]: {
          version: 1,
          completed: ['passphrase', 'not-a-step', 'owner-wallet'],
        },
      },
    })
    expect(state.completed).toEqual(['passphrase', 'owner-wallet'])
  })

  test('a non-object blob is discarded', () => {
    expect(readWizardState({ meta: { [WIZARD_STATE_META_KEY]: 'nope' } }).completed).toEqual([])
    expect(readWizardState({ meta: { [WIZARD_STATE_META_KEY]: [1, 2] } }).completed).toEqual([])
    expect(readWizardState(null).completed).toEqual([])
    expect(readWizardState(undefined).completed).toEqual([])
  })
})
