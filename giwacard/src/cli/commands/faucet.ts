import { privateKeyToAddress } from 'viem/accounts'

import {
  GUSD_FAUCET_AMOUNT,
  GUSD_DECIMALS,
  GUSD_SYMBOL,
  gusdAbi,
} from '../../chain/gusdAbi.js'
import { sendTx, type TxPhaseEvent } from '../chain.js'
import {
  requireKey,
  requireTokenAddress,
  unsealKeystore,
  type CliRuntime,
} from '../context.js'
import { faucetCooldownError, formatUnits } from '../errors.js'
import { readTokenBalance, readFaucetAvailableAt } from '../vault.js'
import { readWizardState } from '../wizardState.js'

/**
 * `giwacard faucet` — claim 100 gUSD for the owner wallet.
 *
 * The whole command exists around one interaction state: **the 24h cooldown**.
 * `GUSD.claimFaucet` reverts with `FaucetCooldownActive(availableAt)` and a
 * user who sees that as a decoded revert learns nothing they can act on. So the
 * cooldown is read *before* submitting (`faucetAvailableAt`), and when it is
 * still running the command reports when it unlocks and how long that is —
 * and, critically, sends nothing, so the user does not also pay gas to be told
 * no.
 */

export interface FaucetCommandOptions {
  /** Claim without asking for confirmation. */
  yes?: boolean
}

/**
 * Run `giwacard faucet`.
 *
 * @returns The process exit code.
 * @throws {CliError} `NO_KEYSTORE` on an unconfigured machine, `FAUCET_COOLDOWN`
 * while the 24h window is still open.
 */
export async function runFaucetCommand(
  runtime: CliRuntime,
  options: FaucetCommandOptions = {},
): Promise<number> {
  const keystore = await unsealKeystore(runtime)
  const ownerKey = requireKey(keystore, 'ownerPrivateKey')
  const owner = privateKeyToAddress(ownerKey)
  const state = readWizardState(keystore.data)
  const token = requireTokenAddress(runtime, state.tokenAddress)

  const publicClient = runtime.chain.publicClient()

  const availableAt = await readFaucetAvailableAt(publicClient, token, owner)
  const nowSeconds = BigInt(Math.floor(runtime.now() / 1000))

  if (availableAt > nowSeconds) {
    // Deliberately thrown, not printed: the caller turns a CliError into the
    // exact same message-plus-hint shape every other failure gets, and the
    // non-zero exit code is what a script needs to see.
    throw faucetCooldownError(owner, availableAt, nowSeconds)
  }

  const before = await readTokenBalance(publicClient, token, owner)
  runtime.output.panel('gUSD faucet', [
    { label: 'Owner', value: owner },
    { label: 'Token', value: token },
    { label: 'Balance', value: `${formatUnits(before, GUSD_DECIMALS)} ${GUSD_SYMBOL}` },
    {
      label: 'Claim',
      value: `${formatUnits(GUSD_FAUCET_AMOUNT, GUSD_DECIMALS)} ${GUSD_SYMBOL} (once per 24h)`,
    },
  ])

  if (!options.yes && runtime.prompter.interactive) {
    const go = await runtime.prompter.confirm({
      message: `Claim ${formatUnits(GUSD_FAUCET_AMOUNT, GUSD_DECIMALS)} ${GUSD_SYMBOL} now?`,
      initialValue: true,
    })
    if (!go) {
      runtime.output.line('Nothing claimed.')
      return 0
    }
  }

  const wallet = runtime.chain.wallet(ownerKey)
  const spinner = runtime.prompter.spinner()
  spinner.start('Claiming gUSD')

  try {
    const outcome = await sendTx({
      publicClient,
      wallet,
      preconfClient: runtime.chain.preconfClient(),
      role: 'owner wallet',
      address: token,
      abi: gusdAbi,
      functionName: 'claimFaucet',
      args: [],
      faucetUrl: runtime.config.ethFaucetUrl,
      onPhase: (event: TxPhaseEvent) => spinner.message(event.message),
    })
    spinner.stop(
      outcome.safe
        ? 'gUSD claimed and settled.'
        : 'gUSD claimed — included, not yet safe.',
    )

    const after = await readTokenBalance(publicClient, token, owner)
    runtime.output.panel('Claimed', [
      { label: 'Amount', value: `${formatUnits(after - before, GUSD_DECIMALS)} ${GUSD_SYMBOL}` },
      { label: 'Balance', value: `${formatUnits(after, GUSD_DECIMALS)} ${GUSD_SYMBOL}` },
      { label: 'Transaction', value: outcome.explorerUrl },
      {
        label: 'Finality',
        value: outcome.safe
          ? 'safe (final)'
          : 'included but not yet safe — it can still be reorged',
      },
      { label: 'Next claim', value: 'in 24 hours' },
    ])
    return 0
  } catch (error) {
    spinner.stop('Faucet claim failed.', 1)
    throw error
  }
}
