# GIWA Insights — the GiwaCard demo merchant

A paid API that answers HTTP **402** with payment requirements, then charges the
card it is presented and serves its product. It ships with its own x402
facilitator, which **settles**: it submits `CardVault.charge` from the merchant's
own key and then verifies the `CardCharged` event on that transaction.

That direction is not a choice. `CardVault.charge` requires
`msg.sender == card.merchantScope` and pays `msg.sender`, so the merchant is the
party that runs the card — exactly like a real one, where the holder presents the
card and the merchant charges it. **The merchant therefore needs a funded EOA**;
see [Funding the merchant key](#funding-the-merchant-key).

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

### Who submits the charge

The merchant. `CardVault.charge` is guarded by
`msg.sender == card.merchantScope` and transfers to `msg.sender`, so a client
that submitted it would revert with `MerchantScopeMismatch` and pay nobody. The
requirements say so explicitly in `extra.settledBy`, because this is precisely
the detail a client would otherwise have to guess.

The client's entire side of a payment is one header naming a card. It signs
nothing, submits nothing, and **spends no gas**.

```
   client (GiwaCard MCP server)                       merchant
   ────────────────────────────                       ────────
1. GET /insights                          ───────────▶
                                          ◀───────────  402 { x402Version, error,
                                                              reason, accepts: [ … ] }

2. GET /insights                          ───────────▶
   X-PAYMENT: base64({ payload: {                     3. CardVault.charge(cardId, price)
     cardId, vault, chainId } })                          ──▶ GIWA Sepolia
                                                          (from the merchant's own key)

                                                     4. verify CardCharged on its OWN
                                                        receipt: right vault, right
                                                        merchant, right card, right amount
                                          ◀───────────  200 + report
                                                        PAYMENT-RESPONSE: base64({
                                                          transaction: 0x…, … })
```

The settlement transaction hash travels **back**, in `PAYMENT-RESPONSE`. It is
the buyer's receipt.

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
    "payTo": "0x…",                      // charges the card; appears as `merchant` in CardCharged
    "maxTimeoutSeconds": 120,
    "asset": "0x…",                      // gUSD
    "extra": {
      "vault": "0x…",                    // the CardVault charged through, and the ONLY trusted emitter
      "chainId": 91342,
      "tokenSymbol": "gUSD",
      "tokenDecimals": 6,
      "priceDisplay": "1",
      "settlementCall": "CardVault.charge(uint256 cardId, uint256 amount)",
      "settledBy": "merchant",           // NOT the client — the contract allows no other answer
      "settlementEvent": "CardCharged(uint256 indexed cardId, address indexed vaultOwner, address indexed merchant, uint256 amount, uint256 released)",
      "payloadFields": ["cardId", "vault", "chainId"],
      "releasePolicy": "sequencer-block",
      "releasePolicyNote": "…"
    }
  }]
}
```

`extra.vault` is the one field stock x402 has no place for, and it is
load-bearing twice over: it tells the client which vault its card must live in,
and the facilitator's entire security model is "events from *that* address and no
other".

### The `X-PAYMENT` header

Base64 (standard or url-safe, padded or not) of:

```json
{
  "x402Version": 1,
  "scheme": "giwa-vault-charge",
  "network": "giwa-sepolia",
  "payload": { "cardId": "1", "vault": "0x…", "chainId": 91342 }
}
```

Only `cardId` is required. `vault` and `chainId` are the client's own safety
check — state them and a merchant configured for a different vault or chain
refuses (`vault_mismatch` / `unsupported_network`) instead of charging through
something you did not mean. Omitting them means trusting the requirements you
already read, which is a legitimate choice.

`x402Version`, `scheme` and `network` may be omitted (they default to this
merchant's); if present and different, the request is rejected rather than
silently reinterpreted. Raw JSON is also accepted, as a `curl` convenience.

There is deliberately no `transactionHash` field. The client has not made a
transaction — that is the merchant's job.

### The `PAYMENT-RESPONSE` header

Base64 of the settlement receipt: `{ success, transaction, payer (the vault
owner), payee, vault, cardId, amount, released, asset, blockNumber, blockHash,
logIndex, releasePolicy, settledAt }`.

`transaction` is the merchant's own `CardVault.charge` transaction, and it is
what the buyer keeps as proof.

---

## What the facilitator checks

On a paid request the facilitator submits `CardVault.charge(cardId, price)` from
the merchant's key, then verifies its **own** receipt. A settlement is accepted
only when **all** of the following hold:

1. our charge transaction succeeded;
2. it contains a `CardCharged` log emitted **by the configured vault address**;
3. that event's `merchant` is this merchant;
4. its `cardId` is the card we were presented and charged;
5. its `amount` is at least the list price;
6. the cardId has not already bought a report.

That list is unchanged from when this facilitator was read-only and checked a
hash a stranger handed it — because the checks were never about trusting the
*client*. "The RPC did not throw" is not the same claim as "the vault I trust
moved the amount I asked for". Check 2 is the impersonation guard, and it is the
reason the address filter runs *before* any decoded field is believed: anyone can
deploy a lookalike contract emitting a byte-identical `CardCharged`, and the
topics prove nothing about *who* emitted them. Under merchant-pull it catches a
misconfigured `CARD_VAULT_ADDRESS` rather than a hostile client, which is a
smaller threat but a much more likely bug.

Because the checks now run against a transaction we submitted, a failure in
2–5 is a *merchant-side* anomaly and answers **503**, not 402. Telling a buyer to
present another card because our own settlement did something inexplicable would
be, at best, expensive advice.

Check 6 is the replay guard, now keyed on **cardId**. It is held in memory
(`InMemorySettlementStore`) with bounded FIFO eviction, and the cardId is claimed
*synchronously* before the first `await`, so two concurrent requests presenting
the same card cannot both reach the chain. One honest caveat: a process restart,
or eviction past `maxEntries`, forgets old cardIds. What that re-opens is smaller
than it looks — `CardVault` independently flips a charged card to `Used`, so a
forgotten card presented again makes the merchant submit a charge the vault
reverts, and the buyer gets a 402. **A replay can at worst duplicate a report;
it can never move money twice.** A production merchant would persist this store.

A charge that never happened releases the claim, so a buyer whose request lost to
a transient failure can present the same card again. A *report* generation
failure after a successful charge does not release it — the card is `Used`
onchain and the buyer cannot pay again even if we asked — so the settlement is
recorded as an undelivered debt, and the same card id collects the report on a
retry without a second charge. Collecting that debt is atomic, so a burst of
retries ships one report rather than one per request.

### Error codes

Returned as `reason` in the 402/503 body.

The buyer can act on all of these:

| `reason` | Status | Meaning |
| --- | --- | --- |
| `payment_required` | 402 | No `X-PAYMENT` header — the ordinary first request. |
| `malformed_payment_header` | 402 | Header present but not decodable, or missing `cardId`. |
| `unsupported_scheme` | 402 | Header names a scheme this merchant does not implement. |
| `unsupported_network` | 402 | Header names a different network or chain id. |
| `vault_mismatch` | 402 | Header names a `CardVault` this merchant does not settle through. |
| `card_already_settled` | 402 | That cardId already bought a report here. |
| `card_already_used` | 402 | The vault says the card was already charged (AE3). |
| `card_not_active` | 402 | The card is cancelled, reaped, or was never minted. |
| `card_expired` | 402 | The card outlived its expiry. |
| `card_cap_too_low` | 402 | The card's cap is below the list price. |
| `merchant_scope_mismatch` | 402 | The card is scoped to a different merchant. |

These are ours, not theirs — and none of them tells an agent to pay again:

| `reason` | Status | Meaning |
| --- | --- | --- |
| `settlement_failed` | **503** | We could not submit the charge: unfunded key, dead RPC, or a revert we cannot name. Nothing was charged. |
| `chain_unavailable` | **503** | We submitted a charge and could not read its receipt. |
| `no_charge_event` | **503** | Our own successful transaction carried no `CardCharged`. |
| `wrong_vault` | **503** | The event came from a contract that is not our configured vault. |
| `wrong_merchant` | **503** | Our own charge paid someone else. |
| `card_id_mismatch` | **503** | Our own charge settled a different card. |
| `amount_below_price` | **503** | Our own charge moved less than the list price. |

The vault reverts in the first table cost nobody gas: viem estimates gas before
signing, so a doomed `charge` is rejected by the node and never mined.

---

## KTD-5 release policy — read this

**The report is released once the charge transaction is included in a sequencer
block. We do not wait for the safe block.**

On an OP Stack testnet a sequencer block can in principle be reorged, so a report
could be released against a charge that later disappears — the merchant would
have delivered its product for nothing. Note which way the risk points under
merchant-pull: a reorg un-pays the *merchant*, never the buyer.

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

## Funding the merchant key

The merchant submits `CardVault.charge`, so it signs, so it pays gas. This is the
one operational cost the read-only design used to avoid, and it is small:

- one `CardVault.charge` on GIWA Sepolia is a ~70k-gas L2 transaction at a
  sub-gwei base fee — **on the order of 1e-5 ETH**;
- a single daily faucet claim therefore covers **hundreds** of charges;
- the merchant only spends gas on charges the vault will accept. viem estimates
  gas before signing, so a card that is spent, expired, under-capped or scoped
  elsewhere is rejected by the node and costs nothing.

Set `MERCHANT_PRIVATE_KEY` to the key of `MERCHANT_ADDRESS` and keep that account
topped up. Two things are checked at startup rather than at the first sale:

- **the key is present.** A missing key exits with a message naming the variable.
- **the key derives to `MERCHANT_ADDRESS`.** `CardVault.charge` demands
  `msg.sender == card.merchantScope`, so a merchant holding the wrong key would
  start cleanly and then fail every single settlement — the worst possible time
  to discover a typo.

The key is never logged, never returned by an endpoint, and never interpolated
into a configuration error; validation messages quote the setting name and the
length, never the value.

For anything beyond a demo, this key should come from a secret manager or a
hardware signer rather than an environment variable, and it should hold nothing
but gas — the gUSD it collects can be swept elsewhere.

---

## Running it

```sh
bun install

MERCHANT_ADDRESS=0x…      \
MERCHANT_PRIVATE_KEY=0x…  \
CARD_VAULT_ADDRESS=0x…    \
GUSD_ADDRESS=0x…          \
bun run start             # or: bun run dev  (watch mode)
```

| Variable | Required | Default |
| --- | --- | --- |
| `MERCHANT_ADDRESS` | yes | — |
| `MERCHANT_PRIVATE_KEY` | yes | — (must derive to `MERCHANT_ADDRESS`, and hold ETH) |
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
| `GET` | `/health` | free — liveness and settled-card count |
| `GET` | `/.well-known/x402` | free — discovery: the paid resource catalogue |
| `GET` | `/insights` | **1 gUSD** — the report |

### Trying it by hand

```sh
# 1. See the requirements.
curl -s localhost:4021/insights | jq

# 2. Present a card. Mint it first from the GiwaCard side, scoped to
#    MERCHANT_ADDRESS with a cap of at least the list price. You submit nothing:
#    the merchant charges the card and returns the settlement hash.
curl -s localhost:4021/insights \
  -H "X-PAYMENT: $(printf '{"payload":{"cardId":"1"}}' | base64)" \
  -D - | jq

# 3. Read the receipt out of the PAYMENT-RESPONSE header.
#    …| grep -i '^payment-response:' | cut -d' ' -f2 | base64 -d | jq
```

---

## Scripts

| Script | What it does |
| --- | --- |
| `bun test` | Full suite. Chain access is injected, so it never touches a live RPC or a real key. |
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
| `src/verify.ts` | The facilitator: `charge` + `CardCharged` ABI, settlement, verification, replay store. |
| `src/insights.ts` | The product: live-RPC report generation. |
| `src/chain.ts` | GIWA Sepolia chain definition, retry/backoff, read and wallet clients. |
| `src/config.ts` | Configuration and validation. |
| `src/index.ts` | The Hono app and library surface. |
| `src/server.ts` | Bun entrypoint. |
