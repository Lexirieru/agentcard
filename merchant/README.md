# GIWA Insights — the GiwaCard demo merchant

A paid API that answers HTTP **402** with payment requirements, then serves its
product once payment is verified onchain. It ships with its own x402
facilitator, which is **read-only**: it verifies a `CardVault` event, it never
submits a transaction and never holds a funded key.

This is the merchant side of the GiwaCard demo loop. It is operator-run, not
published to npm.

---

## The product

**GIWA Insights** — an on-demand analytics report about GIWA Sepolia itself:
sequencer block cadence, gas utilisation against the block limit, base-fee
movement, and transaction activity (including the OP Stack L1→L2 deposit
transactions that are specific to this chain) over a recent block window.

Every number is computed live from the chain's own JSON-RPC — `eth_blockNumber`,
`eth_gasPrice`, and one `eth_getBlockByNumber` per sampled block. There is **no
third-party analytics API and no API key** to configure; a demo that needs
someone else's key is a demo that stops working.

Price: **1 gUSD** per request (configurable).

A real response, generated against live GIWA Sepolia:

```json
{
  "cadence": { "meanBlockSeconds": 1, "blocksPerMinute": 60, "jitterSeconds": 0 },
  "gas": { "meanUtilisationPct": 5.453, "peakUtilisationPct": 10.301, "gasLimit": "60000000" },
  "activity": {
    "totalTransactions": 314,
    "transactionsPerSecond": 44.857,
    "uniqueSenders": 106,
    "transactionTypes": { "eip1559": 220, "legacy": 86, "deposit": 8 }
  },
  "highlights": [
    "Sequencer produced 8 blocks (#32,246,436–#32,246,443) covering 7s, at a mean of 1s per block (median 1s, jitter ±0s).",
    "8 of the 314 transactions were OP Stack deposit transactions (L1 → L2 messages), which is traffic bridged from Ethereum Sepolia rather than native L2 activity."
  ]
}
```

---

## The payment protocol (KTD-9)

We do **not** use Permit2, and we do **not** use x402's stock `exact_evm` scheme.

x402's `exact_evm` settles with Permit2 `SignatureTransfer`, which pulls tokens
**from the signer's own ERC-20 balance**. In GiwaCard the gUSD is escrowed
*inside* `CardVault` and the paying session EOA holds no gUSD at all — that rail
simply cannot settle, because there is nothing in the signer's balance to pull.
And since `CardVault.charge` already moves funds from vault escrow to the
merchant in a single transaction, a Permit2 hop would be redundant even if it
worked.

So the scheme is ours, but the *shape* is deliberately x402's, so that anyone who
knows x402 can read it.

```
   client (GiwaCard MCP server)                       merchant
   ────────────────────────────                       ────────
1. GET /insights                          ───────────▶
                                          ◀───────────  402 { x402Version, error,
                                                              reason, accepts: [ … ] }

2. CardVault.charge(cardId, amount)  ──▶ GIWA Sepolia
   (submitted by the session EOA;
    the merchant never submits it)

3. GET /insights                          ───────────▶
   X-PAYMENT: base64({ payload: {                     4. facilitator reads the receipt,
     transactionHash, cardId } })                        verifies the CardCharged event
                                          ◀───────────  200 + report
                                                        PAYMENT-RESPONSE: base64({ … })
```

Header names stay in the x402 family: `PAYMENT-REQUIRED`-style requirements in
the 402 body, `X-PAYMENT` on the request, `PAYMENT-RESPONSE` on the response.

### The 402 body

```jsonc
{
  "x402Version": 1,
  "error": "Payment required: 1 gUSD. …",
  "reason": "payment_required",          // machine-readable, see the error table
  "accepts": [{
    "scheme": "giwa-vault-charge",       // not exact_evm — see above
    "network": "giwa-sepolia",
    "maxAmountRequired": "1000000",      // base units (gUSD has 6 decimals)
    "resource": "https://…/insights",
    "description": "GIWA Insights — …",
    "mimeType": "application/json",
    "payTo": "0x…",                      // must appear as `merchant` in CardCharged
    "maxTimeoutSeconds": 120,
    "asset": "0x…",                      // gUSD
    "extra": {
      "vault": "0x…",                    // the CardVault to call, and the ONLY trusted emitter
      "chainId": 91342,
      "tokenSymbol": "gUSD",
      "tokenDecimals": 6,
      "priceDisplay": "1",
      "settlementCall": "CardVault.charge(uint256 cardId, uint256 amount)",
      "settlementEvent": "CardCharged(uint256 indexed cardId, address indexed vaultOwner, address indexed merchant, uint256 amount, uint256 released)",
      "payloadFields": ["transactionHash", "cardId"],
      "releasePolicy": "sequencer-block",
      "releasePolicyNote": "…"
    }
  }]
}
```

`extra.vault` is the one field stock x402 has no place for, and it is
load-bearing twice over: without it the client would not know which contract to
call, and the facilitator's entire security model is "events from *that* address
and no other".

### The `X-PAYMENT` header

Base64 (standard or url-safe, padded or not) of:

```json
{
  "x402Version": 1,
  "scheme": "giwa-vault-charge",
  "network": "giwa-sepolia",
  "payload": { "transactionHash": "0x…64 hex", "cardId": "1" }
}
```

`x402Version`, `scheme` and `network` may be omitted (they default to this
merchant's); if present and different, the request is rejected rather than
silently reinterpreted. Raw JSON is also accepted, as a `curl` convenience.

### The `PAYMENT-RESPONSE` header

Base64 of the settlement receipt: `{ success, transaction, payer (the vault
owner), payee, vault, cardId, amount, released, asset, blockNumber, blockHash,
logIndex, releasePolicy, settledAt }`.

---

## What the facilitator checks

A receipt is accepted only when **all** of the following hold:

1. the transaction exists and succeeded;
2. it contains a `CardCharged` log emitted **by the configured vault address**;
3. that event's `merchant` is this merchant;
4. its `cardId` matches the one the client claimed in `X-PAYMENT`;
5. its `amount` is at least the list price;
6. the transaction hash has not already bought a report.

Check 2 is the impersonation guard, and it is the reason the address filter runs
*before* any decoded field is believed. Anyone can deploy a lookalike contract
that emits a byte-identical `CardCharged` with a perfect merchant, cardId and
amount — the topics prove nothing about *who* emitted them. Only the log's
`address` does.

Check 6 is the replay guard. It is held in memory (`InMemoryReceiptStore`) with
bounded FIFO eviction, and the hash is claimed *synchronously* before the first
`await`, so two concurrent requests carrying the same receipt cannot both be
served. One honest caveat: a process restart, or eviction past `maxEntries`,
re-opens replay for old hashes. A production merchant would persist this store.
Note that `CardVault` independently flips a charged card to `Used`, so a replayed
receipt can never move money a second time — only serve a second copy of a
report.

Verification failures release the claim, so a client whose request lost to a
transient RPC error can retry with the same honest receipt. So does a *report*
generation failure after a verified payment: the buyer paid, so they get a 503
with `receiptReleased: true` and can retry with the same header rather than
burning a second card.

### Error codes

Returned as `reason` in the 402 body.

| `reason` | Status | Meaning |
| --- | --- | --- |
| `payment_required` | 402 | No `X-PAYMENT` header — the ordinary first request. |
| `malformed_payment_header` | 402 | Header present but not decodable, or missing fields. |
| `unsupported_scheme` | 402 | Header names a scheme this merchant does not implement. |
| `unsupported_network` | 402 | Header names a different network. |
| `transaction_not_found` | 402 | The chain has no receipt for that hash (yet). |
| `transaction_reverted` | 402 | The transaction exists but reverted. |
| `no_charge_event` | 402 | Receipt has no `CardCharged` event at all. |
| `wrong_vault` | 402 | `CardCharged` present, but from a contract that is not our vault. |
| `wrong_merchant` | 402 | Charged from our vault, but paid someone else. |
| `card_id_mismatch` | 402 | Paid to us, but for a different card than claimed. |
| `amount_below_price` | 402 | Paid to us for the right card, but under the list price. |
| `receipt_already_used` | 402 | That transaction hash already bought a report. |
| `chain_unavailable` | **503** | The facilitator could not read the chain. Not the client's fault. |

`chain_unavailable` is a 503 on purpose: answering 402 there would tell an agent
to pay a second time for a report it has already paid for.

---

## KTD-5 release policy — read this

**The report is released once the charge transaction is included in a sequencer
block. We do not wait for the safe block.**

On an OP Stack testnet a sequencer block can in principle be reorged, so a report
could be released against a charge that later disappears — the merchant would
have delivered its product for nothing.

That risk is accepted **consciously**. Waiting for the safe block takes minutes,
which would destroy the point of an agent paying for an API call inline. A
merchant selling something irreversible should wait for `safe` instead of copying
this.

The policy is not hidden: it is stated in the 402 requirements
(`extra.releasePolicy` / `extra.releasePolicyNote`), in the `PAYMENT-RESPONSE`
receipt (`releasePolicy`), and in the delivered report's own `notes`.

The merchant also reads the standard RPC at `latest`, **not** the Flashblocks
preconfirmation endpoint. Preconfirmation state is a UX affordance for the
client; it is not evidence that money moved.

---

## The facilitator holds no key

`CardVault.charge` moves the funds, and the client submits it. By the time the
merchant looks, the payment is already onchain — so the facilitator only ever
*reads*. There is no wallet client, no private key, no mnemonic and no keystore
anywhere in this service, and nothing for the process to sign with (KTD-6/KTD-9).

---

## Running it

```sh
bun install

MERCHANT_ADDRESS=0x…      \
CARD_VAULT_ADDRESS=0x…    \
GUSD_ADDRESS=0x…          \
bun run start             # or: bun run dev  (watch mode)
```

| Variable | Required | Default |
| --- | --- | --- |
| `MERCHANT_ADDRESS` | yes | — |
| `CARD_VAULT_ADDRESS` | yes | — |
| `GUSD_ADDRESS` | yes | — |
| `MERCHANT_PRICE_GUSD` | no | `1` |
| `MERCHANT_BASE_URL` | no | `http://localhost:<port>` |
| `MERCHANT_PORT` (or `PORT`) | no | `4021` |
| `GIWA_RPC_URL` | no | `https://sepolia-rpc.giwa.io` |
| `MERCHANT_CHAIN_ID` | no | `91342` |
| `MERCHANT_NETWORK` | no | `giwa-sepolia` |
| `MERCHANT_INSIGHTS_BLOCKS` | no | `30` |
| `MERCHANT_INSIGHTS_CONCURRENCY` | no | `6` |
| `MERCHANT_PAYMENT_TIMEOUT_SECONDS` | no | `120` |

### Endpoints

| Method | Path | Price |
| --- | --- | --- |
| `GET` | `/` | free — service description and how to pay |
| `GET` | `/health` | free — liveness and replay-store size |
| `GET` | `/.well-known/x402` | free — discovery: the paid resource catalogue |
| `GET` | `/insights` | **1 gUSD** — the report |

### Trying it by hand

```sh
# 1. See the requirements.
curl -s localhost:4021/insights | jq

# 2. Charge a card (from the GiwaCard side), then redeem the receipt.
curl -s localhost:4021/insights \
  -H "X-PAYMENT: $(printf '{"payload":{"transactionHash":"0x…","cardId":"1"}}' | base64)" \
  -D - | jq
```

---

## Scripts

| Script | What it does |
| --- | --- |
| `bun test` | Full suite. Chain reads are injected, so it never touches a live RPC. |
| `bun run typecheck` | `tsc --noEmit`. |
| `bun run build` | `tsdown` → `dist/` (ESM). |
| `bun run start` | Serve on Bun. |
| `bun run dev` | Serve with `--watch`. |

The public GIWA endpoints are rate-limited and dev-only, so every read goes
through the exponential-backoff wrapper in `src/chain.ts` (mirroring
`giwacard/src/chain/clients.ts`), and report generation caps its concurrent block
reads.

## Layout

| File | What lives there |
| --- | --- |
| `src/x402.ts` | Wire protocol: requirements, `X-PAYMENT`, `PAYMENT-RESPONSE`, error codes. |
| `src/verify.ts` | The read-only facilitator: `CardCharged` ABI, verification, replay store. |
| `src/insights.ts` | The product: live-RPC report generation. |
| `src/chain.ts` | GIWA Sepolia chain definition, retry/backoff, read-only client. |
| `src/config.ts` | Configuration and validation. |
| `src/index.ts` | The Hono app and library surface. |
| `src/server.ts` | Bun entrypoint. |
