# smartcontracts

Foundry. Two UUPS-upgradeable contracts on GIWA Sepolia (chain 91342).

| File | What it is |
| --- | --- |
| `src/CardVault.sol` | The core. One canonical multi-owner vault: deposits, session keys, cards, escrow. |
| `src/CardTypes.sol` | `CardStatus`, `Card`, `SessionPolicy`, `CardApproval`. |
| `src/GUSD.sol` | Test stablecoin, 6 decimals, with a 24h faucet. |
| `script/Deploy.s.sol` | Deploys both proxies and prints proxy + implementation addresses. |

```bash
forge clean && forge test    # clean first — see below
forge fmt
```

## The model

Funds live in `CardVault`, keyed by **vault owner** address — one deployment
serves everyone. An owner registers a **session key** (the agent's EOA) with a
policy, and that key mints **cards**: one-time spend authorizations carrying a
cap, a merchant scope, and an expiry.

## Things that will bite you

**`forge clean` before `forge test` after editing a contract.** `out/build-info`
accumulates one file per compile and the OZ upgrades plugin validates the whole
directory, so you get `Found multiple contracts with name src/X.sol:X`.

**The merchant charges the card, not the agent.** `charge` requires
`msg.sender == card.merchantScope` and pays out to `msg.sender`. An earlier
design had the agent pushing payment; it could never have worked and the mistake
survived in three other packages before anything forced them to meet.

**No general nonce bitmap.** Card status *is* the replay protection. In-policy
mints carry no signature at all — the signer would be the sender, so it would
verify nothing. EIP-712 exists only on the owner-approved over-policy path,
where a one-time `approvalId` prevents replay.

**`escrowedTotal` is an accumulator, never a sum.** Summing active cards is
unbounded gas. It moves on mint, charge, cancel and reap — nowhere else.

**Expired escrow needs a transaction.** The EVM has no timer, so an expired card
still reads `Active` until someone calls the permissionless `releaseExpired`.

**`merchantAllowlist` is deny-by-default.** An empty allowlist mints nothing. An
open card (`merchantScope == address(0)`, chargeable by anyone) is reachable only
through the owner-signed path.

**`dailyCap` is consumed at mint and never refunded** by cancellation or expiry.
It rate-limits authorization, not settlement — otherwise a compromised agent
could mint-and-cancel around it.

**Two different owners.** `owner()` from Ownable is the protocol **admin** and is
used only by `_authorizeUpgrade`. Every user-facing parameter is `vaultOwner`.
`test_AdminHasNoPowerOverVaultOwnerFunds` pins that the admin cannot touch user
funds — keep it that way.

**UUPS rules:** `_disableInitializers()` in the constructor, storage append-only
behind `__gap`, `_authorizeUpgrade` gated `onlyOwner`, and a V1→V2 test asserting
storage survives. A V2 that appends state needs a `reinitializer(2)` or
validation fails with `missing-initializer`.

## Deploying

Use a Foundry keystore account, never a raw private key in an env var:

```bash
cast wallet import deployer --interactive
forge script script/Deploy.s.sol:Deploy --account deployer \
  --rpc-url $GIWA_SEPOLIA_RPC_URL --broadcast --verify \
  --verifier blockscout --verifier-url https://sepolia-explorer.giwa.io/api
```

The `/api` suffix is required. Verify implementations before proxies — Blockscout
only offers "Read/Write as Proxy" once the implementation behind the ERC-1967
slot is verified. Foundry↔Blockscout verification is known to be flaky on OP
Stack chains; keep the standard-json input for a manual verify.
