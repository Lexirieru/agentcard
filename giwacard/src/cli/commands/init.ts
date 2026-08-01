import { isAddress, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'

import { cardVaultAbi } from '../../chain/cardVaultAbi.js'
import { giwaSepoliaExplorer } from '../../chain/giwaSepolia.js'
import {
  GUSD_DECIMALS,
  GUSD_FAUCET_AMOUNT,
  GUSD_SYMBOL,
  gusdAbi,
} from '../../chain/gusdAbi.js'
import {
  keystoreExists,
  keystorePath,
  passphrasesMatch,
  saveKeystore,
  type KeystoreData,
} from '../../chain/keystore.js'
import {
  agentHostDescriptor,
  allAgentHosts,
  passphraseInstructions,
  resolveAgentHostId,
  writeAgentConfig,
  DEFAULT_AGENT_HOST,
  type AgentHostId,
} from '../agentConfig.js'
import { bannerText } from '../banner.js'
import {
  gasBudgetCells,
  readGasBudget,
  sendTx,
  withCliRetry,
  type CliPublicClient,
} from '../chain.js'
import {
  DEFAULT_POLICY,
  OWNER_GAS_TARGET_WEI,
  SESSION_KEY_GAS_TARGET_WEI,
} from '../config.js'
import { unsealKeystore, type CliRuntime } from '../context.js'
import {
  CliError,
  cancelledError,
  faucetCooldownError,
  formatDuration,
  formatEth,
  formatUnits,
} from '../errors.js'
import {
  readFaucetAvailableAt,
  readPaymentToken,
  readTokenBalance,
} from '../vault.js'
import {
  completeStep,
  describeResume,
  isResumable,
  isStepComplete,
  readWizardState,
  writeWizardState,
  WIZARD_STEPS,
  WIZARD_STEP_LABELS,
  type WizardState,
  type WizardStepId,
} from '../wizardState.js'

/**
 * `giwacard init` — the onboarding wizard (flow F1).
 *
 * Eight ordered steps, each of which either does its work or recognises that a
 * previous run already did it. The ordering is not cosmetic: step 7 registers
 * the session policy **and seeds the demo merchant into the allowlist**, and
 * because `CardVault`'s allowlist is deny-by-default, skipping that seeding
 * leaves a setup that looks complete and cannot mint a single usable card. That
 * is why the merchant address is asked for rather than treated as optional.
 *
 * ## Resumability
 *
 * Steps 4, 5 and 6 involve a faucet, a human, and gas — the three things most
 * likely to make a user Ctrl-C. Progress is committed to the encrypted keystore
 * after every step (see `../wizardState.ts`), so a second `giwacard init` picks
 * up at the first unfinished step rather than re-running five transactions. The
 * wizard announces where it is resuming from, so an interrupted run never looks
 * like a fresh one.
 *
 * ## What it does not do
 *
 * It never deploys a contract. KTD-17: `CardVault` is one canonical multi-owner
 * proxy and the wizard *attaches* to it.
 */

export interface InitCommandOptions {
  /** Start over: ignore any recorded progress and re-run every step. */
  fresh?: boolean
  /** Agent host to configure without asking. */
  host?: string
  /** Accept every default and never prompt for confirmation. */
  yes?: boolean
}

/** How long the ETH faucet step waits for a balance to appear, in ms. */
export const ETH_FAUCET_POLL_TIMEOUT_MS = 10 * 60 * 1000

/** How often the ETH faucet step re-reads the balance. */
export const ETH_FAUCET_POLL_INTERVAL_MS = 5_000

/** Minimum owner ETH balance the wizard treats as "the faucet arrived". */
export const ETH_FAUCET_MIN_WEI = 1_000_000_000_000_000n

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Mutable state carried between steps of one wizard run. */
interface WizardRun {
  runtime: CliRuntime
  options: InitCommandOptions
  state: WizardState
  /** Held in memory only; committed to nothing but the keystore's KDF. */
  passphrase: string
  data: KeystoreData
}

/**
 * Persist progress.
 *
 * Called after every step rather than at the end, because the whole point of the
 * state is to survive an interruption *between* steps.
 */
function commit(run: WizardRun, step: WizardStepId, patch: Partial<WizardState> = {}): void {
  run.state = completeStep(run.state, step, patch)
  run.data = writeWizardState(run.data, run.state)
  saveKeystore(run.data, run.passphrase, run.runtime.keystoreOptions)
}

/** Announce a step, with its position in the sequence. */
function heading(run: WizardRun, step: WizardStepId): void {
  const index = WIZARD_STEPS.indexOf(step) + 1
  run.runtime.output.blank()
  run.runtime.output.line(
    `[${index}/${WIZARD_STEPS.length}] ${WIZARD_STEP_LABELS[step]}`,
  )
}

/** Note that a step was already done and is being skipped. */
function skipping(run: WizardRun, step: WizardStepId, detail: string): void {
  const index = WIZARD_STEPS.indexOf(step) + 1
  run.runtime.output.line(
    `[${index}/${WIZARD_STEPS.length}] ${WIZARD_STEP_LABELS[step]} — already done (${detail}).`,
  )
}

/**
 * Run `giwacard init`.
 *
 * @returns The process exit code.
 */
export async function runInitCommand(
  runtime: CliRuntime,
  options: InitCommandOptions = {},
): Promise<number> {
  runtime.output.line(bannerText({ capabilities: runtime.output.capabilities }))
  runtime.output.blank()

  const run = await stepPassphrase(runtime, options)

  if (isResumable(run.state) && !options.fresh) {
    runtime.output.line(describeResume(run.state))
    runtime.output.blank()
  }

  await stepOwnerWallet(run)
  await stepVaultAttach(run)
  await stepEthFaucet(run)
  await stepGusdFaucet(run)
  await stepSessionKey(run)
  await stepPolicy(run)
  await stepAgentConfig(run)

  runtime.output.blank()
  runtime.output.panel('Setup complete', [
    { label: 'Owner', value: run.state.ownerAddress ?? '(unknown)' },
    { label: 'Session key', value: run.state.sessionAddress ?? '(unknown)' },
    { label: 'Vault', value: run.state.vaultAddress ?? '(unknown)' },
    { label: 'Merchants', value: (run.state.merchants ?? []).join(', ') || '(none)' },
    { label: 'Keystore', value: keystorePath(runtime.keystoreOptions) },
  ])
  runtime.output.line('Next: `giwacard status`, then ask your agent to buy something.')
  return 0
}

/* -------------------------------------------------------------------------- */
/* 1. Passphrase                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Ask for the keystore passphrase — once — and open or create the keystore.
 *
 * KTD-15: this value is never written anywhere. It derives the keystore key and
 * lives in memory for the duration of the process. The confirmation step uses
 * {@link passphrasesMatch}, which is constant-time, so a mistyped confirmation
 * cannot be probed character by character.
 */
async function stepPassphrase(
  runtime: CliRuntime,
  options: InitCommandOptions,
): Promise<WizardRun> {
  const path = keystorePath(runtime.keystoreOptions)
  const exists = keystoreExists(runtime.keystoreOptions)

  if (exists) {
    const opened = await unsealKeystore(runtime, {
      message: 'Keystore passphrase (the one you set the first time)',
    })
    const state = options.fresh
      ? { version: 1 as const, completed: [] }
      : readWizardState(opened.data)
    const run: WizardRun = {
      runtime,
      options,
      state,
      passphrase: opened.passphrase,
      data: opened.data,
    }
    skipping(run, 'passphrase', `keystore at ${path}`)
    if (!isStepComplete(run.state, 'passphrase')) commit(run, 'passphrase')
    return run
  }

  runtime.output.line(
    'giwacard keeps your owner wallet and session key in an encrypted keystore ' +
      `at ${path}. The passphrase is never stored — losing it means losing the ` +
      'keystore, by design.',
  )

  const passphrase = await runtime.prompter.password({
    message: 'Choose a keystore passphrase',
    validate: (value) =>
      value.length < 8 ? 'Use at least 8 characters.' : undefined,
  })
  const again = await runtime.prompter.password({
    message: 'Confirm the passphrase',
  })
  if (!passphrasesMatch(passphrase, again)) {
    throw new CliError('CANCELLED', 'The two passphrases did not match.', {
      hint: 'Re-run `giwacard init`. Nothing was written.',
    })
  }

  const data: KeystoreData = {}
  saveKeystore(data, passphrase, runtime.keystoreOptions)

  const run: WizardRun = {
    runtime,
    options,
    state: { version: 1, completed: [] },
    passphrase,
    data,
  }
  commit(run, 'passphrase')
  runtime.output.line(`Keystore created at ${path} (mode 0600).`)
  return run
}

/* -------------------------------------------------------------------------- */
/* 2. Owner wallet                                                            */
/* -------------------------------------------------------------------------- */

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/

/** Create or import the owner EOA — the address every card's funds belong to. */
async function stepOwnerWallet(run: WizardRun): Promise<void> {
  if (isStepComplete(run.state, 'owner-wallet') && run.data.ownerPrivateKey) {
    // The key is the source of truth. A recorded address that disagrees with it
    // — hand-edited, or written by an older build — is corrected rather than
    // trusted, because every later step keys off the address.
    const address = privateKeyToAddress(run.data.ownerPrivateKey)
    if (run.state.ownerAddress !== address) {
      commit(run, 'owner-wallet', { ownerAddress: address })
    }
    skipping(run, 'owner-wallet', address)
    return
  }
  heading(run, 'owner-wallet')

  let key: Hex
  if (run.data.ownerPrivateKey) {
    key = run.data.ownerPrivateKey
    run.runtime.output.line('Reusing the owner wallet already in the keystore.')
  } else {
    const choice = run.options.yes
      ? 'create'
      : await run.runtime.prompter.select<'create' | 'import'>({
          message: 'Owner wallet',
          options: [
            { value: 'create', label: 'Create a new wallet', hint: 'recommended for testnet' },
            { value: 'import', label: 'Import an existing private key' },
          ],
          initialValue: 'create',
        })

    if (choice === 'create') {
      key = generatePrivateKey()
    } else {
      const entered = await run.runtime.prompter.password({
        message: 'Owner private key (0x + 64 hex)',
        validate: (value) =>
          PRIVATE_KEY_RE.test(value.trim())
            ? undefined
            : 'Expected 0x followed by 64 hex characters.',
      })
      key = entered.trim() as Hex
    }
    run.data = { ...run.data, ownerPrivateKey: key }
  }

  const address = privateKeyToAddress(key)
  commit(run, 'owner-wallet', { ownerAddress: address })
  run.runtime.output.panel('Owner wallet', [
    { label: 'Address', value: address },
    { label: 'Explorer', value: giwaSepoliaExplorer.address(address) },
    { label: 'Key', value: 'encrypted in the keystore, never printed' },
  ])
}

/* -------------------------------------------------------------------------- */
/* 3. Attach to the vault (KTD-17)                                            */
/* -------------------------------------------------------------------------- */

/**
 * Attach to the canonical `CardVault`.
 *
 * Attach, never deploy. The vault is a single multi-owner proxy keyed by owner
 * address, so there is nothing per-user to create — and deploying one per user
 * would mean a deployer key, a verification step and a gas bill on every
 * onboarding.
 *
 * The token address is read back from the vault itself (`paymentToken()`) rather
 * than asked for. It is the vault's own answer, so it cannot disagree with the
 * contract the way a second prompt could.
 */
async function stepVaultAttach(run: WizardRun): Promise<void> {
  if (isStepComplete(run.state, 'vault-attach') && run.state.vaultAddress) {
    skipping(run, 'vault-attach', run.state.vaultAddress)
    return
  }
  heading(run, 'vault-attach')

  let vault = run.runtime.config.vaultAddress ?? run.state.vaultAddress ?? null
  if (vault === null) {
    run.runtime.output.line(
      'giwacard attaches to one canonical CardVault shared by every owner. It ' +
        'does not deploy a contract for you.',
    )
    const entered = await run.runtime.prompter.text({
      message: 'CardVault proxy address',
      placeholder: '0x…',
      validate: (value) =>
        isAddress(value.trim()) ? undefined : 'Expected a 0x-prefixed EVM address.',
    })
    vault = entered.trim() as Address
  }

  const publicClient = run.runtime.chain.publicClient()
  const token =
    run.runtime.config.tokenAddress ??
    (await readPaymentToken(publicClient, vault))

  commit(run, 'vault-attach', { vaultAddress: vault, tokenAddress: token })
  run.runtime.output.panel('Attached', [
    { label: 'Vault', value: vault },
    { label: 'Settles in', value: `${token} (${GUSD_SYMBOL})` },
    { label: 'Explorer', value: giwaSepoliaExplorer.address(vault) },
  ])
}

/* -------------------------------------------------------------------------- */
/* 4. ETH faucet                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Wait for the owner wallet to hold enough ETH to pay for gas.
 *
 * The faucet is a web page, not an RPC call — so this step's job is to show the
 * link, then poll the balance until it changes, so the user is not left guessing
 * whether their claim landed. It reports the balance each time it looks, which
 * matters more than it sounds: a poll with no visible progress is
 * indistinguishable from a hang.
 */
async function stepEthFaucet(run: WizardRun): Promise<void> {
  const owner = run.state.ownerAddress
  if (!owner) throw new CliError('KEYSTORE_INCOMPLETE', 'No owner wallet yet.')

  const publicClient = run.runtime.chain.publicClient()
  const balance = await withCliRetry(
    () => publicClient.getBalance({ address: owner }),
    { label: 'read your ETH balance' },
  )

  if (balance >= ETH_FAUCET_MIN_WEI) {
    if (!isStepComplete(run.state, 'eth-faucet')) commit(run, 'eth-faucet')
    skipping(run, 'eth-faucet', `${formatEth(balance)} ETH already`)
    return
  }
  heading(run, 'eth-faucet')

  run.runtime.output.panel('Get testnet ETH', [
    { label: 'Address', value: owner },
    { label: 'Faucet', value: run.runtime.config.ethFaucetUrl },
    { label: 'Balance', value: `${formatEth(balance)} ETH` },
    { label: 'Needed', value: `${formatEth(ETH_FAUCET_MIN_WEI)} ETH to continue` },
  ])
  run.runtime.output.line(
    'Claim from the faucet above, then leave this running — giwacard polls your ' +
      'balance and continues by itself.',
  )

  const spinner = run.runtime.prompter.spinner()
  spinner.start('Waiting for testnet ETH')
  const deadline = run.runtime.now() + ETH_FAUCET_POLL_TIMEOUT_MS

  for (;;) {
    const current = await withCliRetry(
      () => publicClient.getBalance({ address: owner }),
      { label: 'poll your ETH balance' },
    )
    if (current >= ETH_FAUCET_MIN_WEI) {
      spinner.stop(`Funded: ${formatEth(current)} ETH.`)
      commit(run, 'eth-faucet')
      return
    }
    if (run.runtime.now() >= deadline) {
      spinner.stop('Still waiting for testnet ETH.', 1)
      throw new CliError(
        'INSUFFICIENT_GAS',
        `${owner} still holds ${formatEth(current)} ETH after ` +
          `${formatDuration(BigInt(ETH_FAUCET_POLL_TIMEOUT_MS / 1000))} of waiting.`,
        {
          hint:
            `Claim from ${run.runtime.config.ethFaucetUrl} and re-run ` +
            '`giwacard init` — it resumes exactly here, nothing is lost.',
        },
      )
    }
    spinner.message(
      `Waiting for testnet ETH at ${owner} (currently ${formatEth(current)} ETH)`,
    )
    await sleep(ETH_FAUCET_POLL_INTERVAL_MS)
  }
}

/* -------------------------------------------------------------------------- */
/* 5. gUSD faucet                                                             */
/* -------------------------------------------------------------------------- */

/** Claim 100 gUSD, or explain the cooldown and carry on. */
async function stepGusdFaucet(run: WizardRun): Promise<void> {
  const owner = run.state.ownerAddress
  const token = run.state.tokenAddress
  if (!owner || !token) {
    throw new CliError('KEYSTORE_INCOMPLETE', 'The vault has not been attached yet.')
  }

  if (isStepComplete(run.state, 'gusd-faucet')) {
    skipping(run, 'gusd-faucet', 'claimed on an earlier run')
    return
  }
  heading(run, 'gusd-faucet')

  const publicClient = run.runtime.chain.publicClient()
  const availableAt = await readFaucetAvailableAt(publicClient, token, owner)
  const nowSeconds = BigInt(Math.floor(run.runtime.now() / 1000))

  if (availableAt > nowSeconds) {
    // A cooldown is not a setup failure: the address already has gUSD from an
    // earlier claim. Report it precisely and keep going.
    const cooldown = faucetCooldownError(owner, availableAt, nowSeconds)
    run.runtime.prompter.warn(cooldown.message)
    const held = await readTokenBalance(publicClient, token, owner)
    run.runtime.output.line(
      `You already hold ${formatUnits(held, GUSD_DECIMALS)} ${GUSD_SYMBOL}; ` +
        'continuing without a new claim.',
    )
    commit(run, 'gusd-faucet')
    return
  }

  const spinner = run.runtime.prompter.spinner()
  spinner.start(`Claiming ${formatUnits(GUSD_FAUCET_AMOUNT, GUSD_DECIMALS)} ${GUSD_SYMBOL}`)
  try {
    const outcome = await sendTx({
      publicClient,
      wallet: run.runtime.chain.wallet(requireOwnerKey(run)),
      preconfClient: run.runtime.chain.preconfClient(),
      role: 'owner wallet',
      address: token,
      abi: gusdAbi,
      functionName: 'claimFaucet',
      args: [],
      faucetUrl: run.runtime.config.ethFaucetUrl,
      onPhase: (event) => spinner.message(event.message),
    })
    spinner.stop(outcome.safe ? 'gUSD claimed.' : 'gUSD claimed (not yet safe).')
    const held = await readTokenBalance(publicClient, token, owner)
    run.runtime.output.line(
      `Balance: ${formatUnits(held, GUSD_DECIMALS)} ${GUSD_SYMBOL}. ` +
        `Transaction: ${outcome.explorerUrl}`,
    )
  } catch (error) {
    spinner.stop('gUSD claim failed.', 1)
    throw error
  }
  commit(run, 'gusd-faucet')
}

function requireOwnerKey(run: WizardRun): Hex {
  const key = run.data.ownerPrivateKey
  if (!key) {
    throw new CliError('KEYSTORE_INCOMPLETE', 'The owner wallet is missing.', {
      hint: 'Re-run `giwacard init`; it resumes at the owner-wallet step.',
    })
  }
  return key
}

/* -------------------------------------------------------------------------- */
/* 6. Session key + gas budget (KTD-6)                                        */
/* -------------------------------------------------------------------------- */

/**
 * Generate the session key and show the per-submitter gas budget.
 *
 * KTD-6: every transaction giwacard sends has a *named* submitting address —
 * in-policy mints and charges from the session key, approval mints and owner
 * actions from the owner wallet. The table makes that explicit rather than
 * leaving the user to discover it when one of the two runs dry mid-demo.
 *
 * Gas is moved to the session key by a plain value transfer, which the wallet
 * client cannot do through `writeContract`; when no transfer is possible the
 * wizard says so and prints the exact amount to send by hand rather than
 * pretending the key is funded.
 */
async function stepSessionKey(run: WizardRun): Promise<void> {
  if (isStepComplete(run.state, 'session-key') && run.data.sessionPrivateKey) {
    // Same rule as the owner wallet: the key decides the address.
    const recorded = privateKeyToAddress(run.data.sessionPrivateKey)
    if (run.state.sessionAddress !== recorded) {
      commit(run, 'session-key', { sessionAddress: recorded })
    }
    skipping(run, 'session-key', recorded)
    await printGasBudget(run)
    return
  }
  heading(run, 'session-key')

  const key = run.data.sessionPrivateKey ?? generatePrivateKey()
  const address = privateKeyToAddress(key)
  run.data = { ...run.data, sessionPrivateKey: key }

  run.runtime.output.panel('Session key', [
    { label: 'Address', value: address },
    { label: 'Signs', value: 'in-policy mints and merchant charges' },
    { label: 'Cannot', value: 'withdraw, cancel cards, or approve anything' },
    { label: 'Key', value: 'encrypted in the same keystore, never shown to the agent' },
  ])

  commit(run, 'session-key', { sessionAddress: address })
  await printGasBudget(run)
}

/** Print the KTD-6 budget table and warn about any underfunded submitter. */
async function printGasBudget(run: WizardRun): Promise<void> {
  const owner = run.state.ownerAddress
  const session = run.state.sessionAddress
  if (!owner) return

  const publicClient: CliPublicClient = run.runtime.chain.publicClient()
  const budget = await readGasBudget(publicClient, [
    { role: 'owner wallet', address: owner, targetWei: OWNER_GAS_TARGET_WEI },
    ...(session
      ? [
          {
            role: 'session key',
            address: session,
            targetWei: SESSION_KEY_GAS_TARGET_WEI,
          },
        ]
      : []),
  ])

  run.runtime.output.blank()
  run.runtime.output.line('Gas budget by submitting address (KTD-6)')
  run.runtime.output.table({
    head: ['role', 'address', 'balance', 'target', 'state'],
    rows: budget.map(gasBudgetCells),
    empty: 'No submitting addresses yet.',
  })

  const short = budget.filter((row) => !row.funded)
  if (short.length === 0) {
    run.runtime.output.line('Both submitters are funded for the demo.')
    return
  }
  for (const row of short) {
    run.runtime.output.line(
      `  ${row.role} needs about ${formatEth(row.targetWei - row.balanceWei)} more ETH. ` +
        `Send it to ${row.address}, or claim from ${run.runtime.config.ethFaucetUrl}.`,
    )
  }
  run.runtime.output.line(
    '  giwacard checks gas before every transaction, so an underfunded address ' +
      'stops you before anything is signed.',
  )
}

/* -------------------------------------------------------------------------- */
/* 7. Policy + merchant allowlist                                             */
/* -------------------------------------------------------------------------- */

/**
 * Register the session key's policy and seed its merchant allowlist.
 *
 * `registerSessionKey` takes the merchants inline, so the policy and the
 * allowlist are one transaction. That matters: `CardVault`'s allowlist is
 * **deny-by-default**, so a policy registered with an empty merchant array
 * produces a session key that passes every cap check and still cannot mint a
 * single card anyone can charge. F2 depends entirely on the demo merchant being
 * in this array, which is why the wizard asks for it rather than skipping when
 * the environment does not supply one.
 */
async function stepPolicy(run: WizardRun): Promise<void> {
  if (isStepComplete(run.state, 'policy')) {
    skipping(run, 'policy', `${(run.state.merchants ?? []).length} merchant(s) allowed`)
    return
  }
  heading(run, 'policy')

  const owner = run.state.ownerAddress
  const session = run.state.sessionAddress
  const vault = run.state.vaultAddress
  if (!owner || !session || !vault) {
    throw new CliError('KEYSTORE_INCOMPLETE', 'Earlier setup steps have not run.')
  }

  const merchants = [...run.runtime.config.merchants]
  if (merchants.length === 0) {
    run.runtime.output.line(
      'The vault allowlist is deny-by-default: a session key can only mint cards ' +
        'scoped to a merchant you have explicitly allowed. Without at least one, ' +
        'your agent cannot buy anything.',
    )
    const entered = await run.runtime.prompter.text({
      message: 'Demo merchant address to allow',
      placeholder: '0x…',
      validate: (value) =>
        isAddress(value.trim()) ? undefined : 'Expected a 0x-prefixed EVM address.',
    })
    merchants.push(entered.trim() as Address)
  }

  const policy = DEFAULT_POLICY
  run.runtime.output.panel('Default session policy', [
    {
      label: 'Cap per card',
      value: `${formatUnits(policy.capPerCard, GUSD_DECIMALS)} ${GUSD_SYMBOL}`,
    },
    {
      label: 'Daily cap',
      value: `${formatUnits(policy.dailyCap, GUSD_DECIMALS)} ${GUSD_SYMBOL}`,
    },
    { label: 'Max card life', value: formatDuration(policy.maxExpiry) },
    { label: 'Merchants', value: merchants.join('\n') },
    {
      label: 'Over policy',
      value: 'queued for your approval instead of minted (`giwacard approve`)',
    },
  ])

  if (!run.options.yes && run.runtime.prompter.interactive) {
    const go = await run.runtime.prompter.confirm({
      message: 'Register this policy onchain?',
      initialValue: true,
    })
    if (!go) throw cancelledError('Policy not registered.')
  }

  const spinner = run.runtime.prompter.spinner()
  spinner.start('Registering the session key policy')
  try {
    const outcome = await sendTx({
      publicClient: run.runtime.chain.publicClient(),
      wallet: run.runtime.chain.wallet(requireOwnerKey(run)),
      preconfClient: run.runtime.chain.preconfClient(),
      role: 'owner wallet',
      address: vault,
      abi: cardVaultAbi,
      functionName: 'registerSessionKey',
      args: [session, policy.capPerCard, policy.dailyCap, policy.maxExpiry, merchants],
      faucetUrl: run.runtime.config.ethFaucetUrl,
      onPhase: (event) => spinner.message(event.message),
    })
    spinner.stop(outcome.safe ? 'Policy registered.' : 'Policy registered (not yet safe).')
    run.runtime.output.line(`Transaction: ${outcome.explorerUrl}`)
  } catch (error) {
    spinner.stop('Policy registration failed.', 1)
    throw error
  }

  commit(run, 'policy', {
    merchants,
    policy: {
      capPerCard: policy.capPerCard.toString(),
      dailyCap: policy.dailyCap.toString(),
      maxExpiry: policy.maxExpiry.toString(),
    },
  })
}

/* -------------------------------------------------------------------------- */
/* 8. Agent host config                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Write the MCP server entry into the chosen agent host's config file.
 *
 * The host picker lists every file by path, and the result is announced by path
 * too. That is not decoration: the two Claudes read different files, and the
 * only way a user can tell the wizard configured the product they are actually
 * running is to see the filename.
 */
async function stepAgentConfig(run: WizardRun): Promise<void> {
  if (isStepComplete(run.state, 'agent-config')) {
    skipping(run, 'agent-config', (run.state.agentHosts ?? []).join(', ') || 'configured')
    return
  }
  heading(run, 'agent-config')

  const owner = run.state.ownerAddress
  const vault = run.state.vaultAddress
  if (!owner || !vault) {
    throw new CliError('KEYSTORE_INCOMPLETE', 'Earlier setup steps have not run.')
  }

  const overrides = run.runtime.agentConfig ?? {}
  const descriptorOptions = {
    ...(overrides.home !== undefined ? { home: overrides.home } : {}),
    ...(overrides.platform !== undefined ? { platform: overrides.platform } : {}),
    ...(overrides.cwd !== undefined ? { cwd: overrides.cwd } : {}),
  }

  // `resolveAgentHostId` throws for an unknown host, and separately for
  // `claude`, which names two products with two different files.
  const requested =
    run.options.host !== undefined
      ? resolveAgentHostId(run.options.host)
      : undefined

  const hostId: AgentHostId =
    requested ??
    (run.options.yes
      ? DEFAULT_AGENT_HOST
      : await run.runtime.prompter.select<AgentHostId>({
          message: 'Which agent should giwacard register with?',
          options: allAgentHosts(descriptorOptions).map((candidate) => ({
            value: candidate.id,
            label: candidate.label,
            // The path is the only thing that distinguishes the two Claudes.
            hint: candidate.configPath,
          })),
          initialValue: DEFAULT_AGENT_HOST,
        }))

  const host = agentHostDescriptor(hostId, descriptorOptions)

  // KTD-15 says the passphrase is not persisted. The MCP server needs it. That
  // conflict is resolved by asking, defaulting to no, and printing the manual
  // alternative when the answer is no — never by quietly writing it.
  const storePassphrase =
    run.options.yes || !run.runtime.prompter.interactive
      ? false
      : await run.runtime.prompter.confirm({
          message:
            `Store your keystore passphrase in ${host.configPath} so the MCP ` +
            'server can unseal the keystore unattended? It would be written in ' +
            'plaintext.',
          initialValue: false,
        })

  const result = writeAgentConfig({
    host,
    vaultAddress: vault,
    vaultOwner: owner,
    merchants: run.state.merchants ?? [],
    agentLabel: 'giwacard-agent',
    rpcUrl: run.runtime.env.GIWACARD_RPC_URL,
    home: run.runtime.config.home,
    ...(storePassphrase ? { passphrase: run.passphrase } : {}),
    ...(overrides.fs !== undefined ? { fs: overrides.fs } : {}),
  })

  run.runtime.output.panel(`${host.label} configured`, [
    { label: 'File', value: result.path },
    { label: 'Action', value: result.created ? 'created' : result.replaced ? 'updated the giwacard entry' : 'added the giwacard entry' },
    {
      label: 'Left alone',
      value:
        result.preservedServers.length === 0
          ? 'no other MCP servers were configured'
          : result.preservedServers.join(', '),
    },
    { label: 'Passphrase', value: result.passphraseStored ? 'stored in the file' : 'NOT stored' },
    { label: 'Then', value: host.note },
  ])
  // Stated in prose as well as in the panel: "which file" is the one fact a
  // user needs to notice that the wrong Claude was configured.
  run.runtime.output.line(
    `Wrote the giwacard MCP server entry for ${host.label} to ${result.path}.`,
  )

  if (result.passphraseStored && host.id === 'claude-code') {
    run.runtime.output.line(
      `WARNING: ${result.path} now contains your keystore passphrase in ` +
        'plaintext, and .mcp.json is a project file that is routinely ' +
        'committed. Add it to .gitignore, or remove GIWACARD_PASSPHRASE from ' +
        'it and export the variable instead.',
    )
  }

  if (!result.passphraseStored) {
    run.runtime.output.blank()
    run.runtime.output.line(passphraseInstructions(host))
  }

  commit(run, 'agent-config', { agentHosts: [hostId] })
}
