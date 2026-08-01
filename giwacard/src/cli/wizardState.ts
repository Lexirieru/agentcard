import type { Address } from 'viem'

import type { KeystoreData } from '../chain/keystore.js'

/**
 * Resumable state for the onboarding wizard (F1).
 *
 * The wizard walks eight ordered steps, several of which cost gas or wait on a
 * human topping up a faucet. A user who Ctrl-Cs at step 6 — or whose laptop
 * sleeps while they are waiting for testnet ETH — must be able to re-run
 * `giwacard init` and land back where they were, not repeat five transactions.
 *
 * The state lives inside the **encrypted** keystore's `meta` field rather than a
 * plaintext sidecar, for two reasons. It is a hard link between the progress
 * record and the keys it describes: a keystore restored from backup carries its
 * own progress, and a progress file can never survive a keystore that did not.
 * And it means resuming requires the passphrase, which the wizard has to ask for
 * as step 1 anyway.
 *
 * Nothing here is secret — addresses and policy numbers are all public — so the
 * encryption is a coupling decision, not a confidentiality one.
 */

/** The eight steps of F1, in the order the wizard performs them. */
export const WIZARD_STEPS = [
  /** 1. Ask for (and confirm) the keystore passphrase. Never persisted. */
  'passphrase',
  /** 2. Create or import the owner wallet. */
  'owner-wallet',
  /** 3. Attach to the canonical vault (KTD-17 — attach only, never deploy). */
  'vault-attach',
  /** 4. ETH faucet: show the link, poll the balance until it arrives. */
  'eth-faucet',
  /** 5. gUSD faucet: `claimFaucet()`. */
  'gusd-faucet',
  /** 6. Generate the session key, fund its gas, show the KTD-6 budget table. */
  'session-key',
  /** 7. Register the default policy, seeding the demo merchant allowlist. */
  'policy',
  /** 8. Write the MCP server config into the agent host's config file. */
  'agent-config',
] as const

/** One step of the wizard. */
export type WizardStepId = (typeof WIZARD_STEPS)[number]

/** Human labels, shown in the resume banner and the step headings. */
export const WIZARD_STEP_LABELS: Readonly<Record<WizardStepId, string>> = {
  passphrase: 'Keystore passphrase',
  'owner-wallet': 'Owner wallet',
  'vault-attach': 'Attach to the vault',
  'eth-faucet': 'Fund the owner with testnet ETH',
  'gusd-faucet': 'Claim gUSD',
  'session-key': 'Session key and gas budget',
  policy: 'Session policy and merchant allowlist',
  'agent-config': 'Register with your agent host',
}

/** Schema version of the persisted blob. Bumped only on a breaking change. */
export const WIZARD_STATE_VERSION = 1 as const

/** Key under `KeystoreData.meta` where the state lives. */
export const WIZARD_STATE_META_KEY = 'wizard' as const

/** The persisted progress record. */
export interface WizardState {
  version: typeof WIZARD_STATE_VERSION
  /** Steps finished, in completion order. The resume point is derived from it. */
  completed: WizardStepId[]
  ownerAddress?: Address
  sessionAddress?: Address
  vaultAddress?: Address
  tokenAddress?: Address
  /** Merchants seeded into the session key's allowlist. */
  merchants?: Address[]
  policy?: {
    /** gUSD base units. */
    capPerCard: string
    dailyCap: string
    /** Seconds. */
    maxExpiry: string
  }
  /** Agent hosts whose config file has been written. */
  agentHosts?: string[]
  updatedAt?: string
}

/** A fresh, nothing-done state. */
export function emptyWizardState(): WizardState {
  return { version: WIZARD_STATE_VERSION, completed: [] }
}

function isStepId(value: unknown): value is WizardStepId {
  return (
    typeof value === 'string' &&
    (WIZARD_STEPS as readonly string[]).includes(value)
  )
}

/**
 * Read the wizard state out of a decrypted keystore.
 *
 * Anything unrecognised — a hand-edited blob, a future schema version, a
 * truncated write — reads as {@link emptyWizardState}. Starting the wizard over
 * is always safe (every step is idempotent); resuming from a state we cannot
 * interpret is not.
 */
export function readWizardState(data: KeystoreData | null | undefined): WizardState {
  const raw = data?.meta?.[WIZARD_STATE_META_KEY]
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return emptyWizardState()
  }
  const candidate = raw as Partial<WizardState>
  if (candidate.version !== WIZARD_STATE_VERSION) return emptyWizardState()

  const completed = Array.isArray(candidate.completed)
    ? candidate.completed.filter(isStepId)
    : []

  return {
    version: WIZARD_STATE_VERSION,
    // De-duplicated: a resumed run that re-completes a step must not grow the
    // list without bound.
    completed: [...new Set(completed)],
    ...(candidate.ownerAddress ? { ownerAddress: candidate.ownerAddress } : {}),
    ...(candidate.sessionAddress
      ? { sessionAddress: candidate.sessionAddress }
      : {}),
    ...(candidate.vaultAddress ? { vaultAddress: candidate.vaultAddress } : {}),
    ...(candidate.tokenAddress ? { tokenAddress: candidate.tokenAddress } : {}),
    ...(Array.isArray(candidate.merchants)
      ? { merchants: candidate.merchants }
      : {}),
    ...(candidate.policy ? { policy: candidate.policy } : {}),
    ...(Array.isArray(candidate.agentHosts)
      ? { agentHosts: candidate.agentHosts }
      : {}),
    ...(candidate.updatedAt ? { updatedAt: candidate.updatedAt } : {}),
  }
}

/** Write the wizard state back into a keystore payload, without mutating it. */
export function writeWizardState(
  data: KeystoreData,
  state: WizardState,
): KeystoreData {
  return {
    ...data,
    meta: {
      ...(data.meta ?? {}),
      [WIZARD_STATE_META_KEY]: {
        ...state,
        updatedAt: new Date().toISOString(),
      },
    },
  }
}

/** Whether a step has already been completed. */
export function isStepComplete(state: WizardState, step: WizardStepId): boolean {
  return state.completed.includes(step)
}

/** Mark a step complete and merge in whatever it learned. Pure. */
export function completeStep(
  state: WizardState,
  step: WizardStepId,
  patch: Partial<Omit<WizardState, 'version' | 'completed'>> = {},
): WizardState {
  return {
    ...state,
    ...patch,
    version: WIZARD_STATE_VERSION,
    completed: state.completed.includes(step)
      ? state.completed
      : [...state.completed, step],
  }
}

/**
 * The first step that is not yet done, or `null` when the wizard is finished.
 *
 * Derived from {@link WIZARD_STEPS} order rather than from the completion order,
 * so a state where a later step was somehow recorded first still resumes at the
 * earliest gap instead of skipping it.
 */
export function nextStep(state: WizardState): WizardStepId | null {
  for (const step of WIZARD_STEPS) {
    if (!state.completed.includes(step)) return step
  }
  return null
}

/** Every step still to do, in order. */
export function remainingSteps(state: WizardState): WizardStepId[] {
  return WIZARD_STEPS.filter((step) => !state.completed.includes(step))
}

/** Whether the wizard has anything to resume (started but not finished). */
export function isResumable(state: WizardState): boolean {
  return state.completed.length > 0 && nextStep(state) !== null
}

/**
 * A one-line summary of where a resumed run will pick up.
 *
 * @example `Resuming at step 4 of 8: Fund the owner with testnet ETH.`
 */
export function describeResume(state: WizardState): string {
  const step = nextStep(state)
  if (step === null) {
    return 'Setup is already complete. Re-running will confirm each step.'
  }
  const index = WIZARD_STEPS.indexOf(step) + 1
  return (
    `Resuming at step ${index} of ${WIZARD_STEPS.length}: ` +
    `${WIZARD_STEP_LABELS[step]}. ` +
    `${state.completed.length} step(s) already done.`
  )
}
