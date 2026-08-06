import { privateKeyToAddress } from 'viem/accounts'

import { cardVaultAbi } from '../../chain/cardVaultAbi.js'
import { GUSD_DECIMALS, GUSD_SYMBOL, gusdAbi } from '../../chain/gusdAbi.js'
import { sendTx, type TxPhaseEvent } from '../chain.js'
import {
  requireKey,
  requireTokenAddress,
  requireVaultAddress,
  unsealKeystore,
  type CliRuntime,
} from '../context.js'
import { CliError, formatUnits } from '../errors.js'
import { readTokenAllowance, readTokenBalance, readVaultBalances } from '../vault.js'
import { readWizardState } from '../wizardState.js'

/**
 * `giwacard deposit <amount>` — move gUSD from the owner's wallet into the vault.
 *
 * This command exists because onboarding used to end at a wall. `giwacard init`
 * claims 100 gUSD into the *wallet*, but a card is backed by the *vault* balance,
 * and nothing in the CLI or the MCP surface could move funds between the two —
 * only the dashboard could. So the wizard signed off with "ask your agent to buy
 * something" against an available balance of zero, and the agent's first mint
 * failed for a reason no command could fix. The first live end-to-end run walked
 * straight into it.
 *
 * It is owner-only and deliberately absent from the MCP tools. Depositing needs
 * the owner key, and the MCP server holds a session key precisely so that a
 * compromised agent cannot reach the owner's wallet.
 *
 * ERC-20 makes this two transactions, not one. The allowance is read first and
 * `approve` is skipped when the vault is already approved for enough, because
 * paying gas to re-authorise an allowance that already covers the deposit is
 * pure waste on a repeat top-up.
 */

export interface DepositCommandOptions {
  /** Amount in whole gUSD, as typed. `50`, `50.5` and `0.25` are all valid. */
  amount?: string | undefined
  /** Deposit without asking for confirmation. */
  yes?: boolean
}

/**
 * Parse a human-typed gUSD amount into base units.
 *
 * Rejects rather than rounds. A silently truncated `0.1234567` would move a
 * different amount of money than the one the user typed, and money is the one
 * place where a helpful guess is worse than an error.
 *
 * @throws {CliError} `INVALID_ARGUMENT` on anything that is not a positive
 * decimal with at most {@link GUSD_DECIMALS} places.
 */
export function parseGusdAmount(raw: string): bigint {
  const text = raw.trim()

  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new CliError(
      'INVALID_ARGUMENT',
      `"${raw}" is not an amount of ${GUSD_SYMBOL}.`,
      { hint: 'Pass a positive decimal number, for example `giwacard deposit 50`.' },
    )
  }

  const [whole = '0', fraction = ''] = text.split('.')
  if (fraction.length > GUSD_DECIMALS) {
    throw new CliError(
      'INVALID_ARGUMENT',
      `${GUSD_SYMBOL} has ${GUSD_DECIMALS} decimal places and "${raw}" has ${fraction.length}.`,
      { hint: `Round it yourself to ${GUSD_DECIMALS} places, so the amount moved is the amount you meant.` },
    )
  }

  const units = BigInt(whole + fraction.padEnd(GUSD_DECIMALS, '0'))
  if (units === 0n) {
    throw new CliError('INVALID_ARGUMENT', 'A deposit of zero would do nothing.', {
      hint: 'Pass the amount you want to move, for example `giwacard deposit 50`.',
    })
  }
  return units
}

/**
 * Run `giwacard deposit`.
 *
 * @returns The process exit code.
 * @throws {CliError} `INVALID_ARGUMENT` when the amount is missing or malformed,
 * `NO_KEYSTORE` on an unconfigured machine, and whatever {@link sendTx} raises
 * when gas or the chain is the problem.
 */
export async function runDepositCommand(
  runtime: CliRuntime,
  options: DepositCommandOptions = {},
): Promise<number> {
  if (options.amount === undefined || options.amount.trim() === '') {
    throw new CliError(
      'INVALID_ARGUMENT',
      'giwacard deposit needs an amount.',
      { hint: `Run \`giwacard deposit <amount>\`, for example \`giwacard deposit 50\`.` },
    )
  }
  const amount = parseGusdAmount(options.amount)
  const pretty = `${formatUnits(amount, GUSD_DECIMALS)} ${GUSD_SYMBOL}`

  const keystore = await unsealKeystore(runtime)
  const ownerKey = requireKey(keystore, 'ownerPrivateKey')
  const owner = privateKeyToAddress(ownerKey)
  const state = readWizardState(keystore.data)
  const token = requireTokenAddress(runtime, state.tokenAddress)
  const vault = requireVaultAddress(runtime, state.vaultAddress)

  const publicClient = runtime.chain.publicClient()
  const walletBalance = await readTokenBalance(publicClient, token, owner)

  if (walletBalance < amount) {
    throw new CliError(
      'INVALID_ARGUMENT',
      `Your wallet holds ${formatUnits(walletBalance, GUSD_DECIMALS)} ${GUSD_SYMBOL}, ` +
        `which is less than the ${pretty} you asked to deposit. Nothing was sent.`,
      {
        hint:
          'Claim more with `giwacard faucet` (100 gUSD per address per 24 hours), ' +
          'or deposit an amount you hold.',
      },
    )
  }

  const before = await readVaultBalances(publicClient, vault, owner)
  runtime.output.panel('Deposit', [
    { label: 'Owner', value: owner },
    { label: 'Vault', value: vault },
    { label: 'In your wallet', value: `${formatUnits(walletBalance, GUSD_DECIMALS)} ${GUSD_SYMBOL}` },
    { label: 'In the vault', value: `${formatUnits(before.balance, GUSD_DECIMALS)} ${GUSD_SYMBOL}` },
    { label: 'Depositing', value: pretty },
  ])
  runtime.output.line(
    'Cards are backed by the vault balance, not by your wallet. This is the ' +
      'step that makes an agent able to spend.',
  )

  if (!options.yes && runtime.prompter.interactive) {
    const go = await runtime.prompter.confirm({
      message: `Move ${pretty} into the vault?`,
      initialValue: true,
    })
    if (!go) {
      runtime.output.line('Nothing deposited.')
      return 0
    }
  }

  const wallet = runtime.chain.wallet(ownerKey)
  const spinner = runtime.prompter.spinner()

  // ERC-20 needs the vault approved before it can pull. Skip it when a previous
  // deposit already left enough allowance standing.
  const allowance = await readTokenAllowance(publicClient, token, owner, vault)
  if (allowance < amount) {
    spinner.start(`Approving the vault for ${pretty}`)
    try {
      await sendTx({
        publicClient,
        wallet,
        preconfClient: runtime.chain.preconfClient(),
        role: 'owner wallet',
        address: token,
        abi: gusdAbi,
        functionName: 'approve',
        args: [vault, amount],
        faucetUrl: runtime.config.ethFaucetUrl,
        onPhase: (event: TxPhaseEvent) => spinner.message(event.message),
        // Inclusion is enough here, and `sendTx` still waits for the receipt and
        // still throws on a revert. Waiting for a safe block would spend the
        // full 60s timeout twice over — once on an allowance nobody asked about
        // — and on this chain `safe` lags far enough that both waits time out.
        // What the user cares about is the finality of the deposit below.
        waitForSafe: false,
      })
      spinner.stop('Vault approved.')
    } catch (error) {
      spinner.stop('Approval failed. Nothing was deposited.', 1)
      throw error
    }
  }

  spinner.start(`Depositing ${pretty}`)
  try {
    const outcome = await sendTx({
      publicClient,
      wallet,
      preconfClient: runtime.chain.preconfClient(),
      role: 'owner wallet',
      address: vault,
      abi: cardVaultAbi,
      functionName: 'deposit',
      args: [amount],
      faucetUrl: runtime.config.ethFaucetUrl,
      onPhase: (event: TxPhaseEvent) => spinner.message(event.message),
    })
    spinner.stop(
      outcome.safe ? 'Deposited and settled.' : 'Deposited — included, not yet safe.',
    )

    const after = await readVaultBalances(publicClient, vault, owner)
    runtime.output.panel('Deposited', [
      { label: 'Vault balance', value: `${formatUnits(after.balance, GUSD_DECIMALS)} ${GUSD_SYMBOL}` },
      {
        label: 'Available',
        value: `${formatUnits(after.available, GUSD_DECIMALS)} ${GUSD_SYMBOL} (what a new card can be backed by)`,
      },
      { label: 'Transaction', value: outcome.explorerUrl },
      {
        label: 'Finality',
        value: outcome.safe
          ? 'safe (final)'
          : 'included but not yet safe — it can still be reorged',
      },
    ])
    return 0
  } catch (error) {
    spinner.stop('Deposit failed.', 1)
    throw error
  }
}
