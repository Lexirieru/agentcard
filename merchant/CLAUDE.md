# merchant

The demo paid API and its x402 facilitator. Operator-run, **not published** —
`private: true`.

| File | What it is |
| --- | --- |
| `src/index.ts` | Hono app. `/insights` is the paid endpoint. |
| `src/x402.ts` | Wire protocol: requirements, `X-PAYMENT` decode, `PAYMENT-RESPONSE`. |
| `src/verify.ts` | The facilitator: submits the charge, verifies its own receipt, guards replay. |
| `src/insights.ts` | The product — a live chain analytics report. |
| `src/config.ts` | Env validation, including the merchant key. |

```bash
bun test && bun run typecheck && bun run build
```

## The payment scheme

Ours, not x402's stock `exact_evm`. Scheme id `giwa-vault-charge`.

Permit2 cannot settle this: `SignatureTransfer` pulls from the *signer's* balance,
but the gUSD sits escrowed inside `CardVault` and the paying session EOA holds
none. And `CardVault.charge` already moves funds to the merchant, so Permit2 would
be redundant anyway.

1. Unpaid request → `402` with requirements, including `extra.vault` and
   `extra.chainId`. A client must check those match its own vault before paying.
2. Client re-requests with `X-PAYMENT` carrying `{cardId, vault, chainId}`. It
   contains nothing secret — a card is worthless to anyone but the merchant it
   names.
3. **This service** calls `CardVault.charge(cardId, price)` from its own key,
   verifies the `CardCharged` event on its own receipt, and serves the product
   with the settlement hash in `PAYMENT-RESPONSE`.

## Things that will bite you

**The merchant needs a funded EOA.** `MERCHANT_PRIVATE_KEY` is required and its
derived address must equal `MERCHANT_ADDRESS`; startup refuses otherwise. One L2
charge costs on the order of 1e-5 ETH, so a daily faucet claim covers hundreds.

**Verify the emitter, not just the event.** Anyone can deploy a contract that
emits a `CardCharged` with the same shape. The configured vault address is the
only emitter trusted — there is a test for the case where a lookalike log appears
*alongside* a real one.

**`chain_unavailable` answers 503, not 402.** Replying 402 when *our* RPC is down
tells an agent to pay twice.

**A failed report releases the receipt.** If settlement succeeds but the report
does not, the client gets 503 with `receiptReleased: true` and can retry the same
`X-PAYMENT` rather than burning a second card. `takeUndelivered` is atomic —
without that, two concurrent retries each shipped a report for one payment.

**Replay protection is bounded in-memory** and keyed on cardId, so a restart or
an eviction reopens it. That is acceptable only because `CardVault` independently
flips a charged card to `Used`: a replay can duplicate a report, never money.

**The report is released at sequencer inclusion, not at the safe block.** A
deliberate, documented testnet reorg risk — waiting minutes would defeat the demo.
Say so rather than hoping nobody asks.

**Rejection order is vault → merchant → cardId → amount**, so the error code
answers the most fundamental question first: did this even pay me?
