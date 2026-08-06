# GIWA Sepolia deployment

Chain 91342. Deployed 2026-08-02.

| Contract | Address |
| --- | --- |
| CardVault (proxy) | [`0xD89395Df78aaFdF86b330899d1C6189211e88750`](https://sepolia-explorer.giwa.io/address/0xD89395Df78aaFdF86b330899d1C6189211e88750) |
| CardVault (implementation) | [`0x0D7766158f14ad7bB82d9FD8A47734e801E3F5B8`](https://sepolia-explorer.giwa.io/address/0x0D7766158f14ad7bB82d9FD8A47734e801E3F5B8) |
| gUSD (proxy) | [`0xADA0466303441102cb16F8eC1594C744d603f746`](https://sepolia-explorer.giwa.io/address/0xADA0466303441102cb16F8eC1594C744d603f746) |
| gUSD (implementation) | [`0x29faf6cAFA4BeA1dC7c232f0a1818d4da6b724DD`](https://sepolia-explorer.giwa.io/address/0x29faf6cAFA4BeA1dC7c232f0a1818d4da6b724DD) |

**Admin / upgrade owner:** `0x56A2950ddE6B1040d1DCC4b4C4Fc314Bd56eFB0E`

All four verified on Blockscout. Solc 0.8.28, EVM version prague.

The vault is the one canonical multi-owner instance (KTD-17) — clients attach to
it, they never deploy their own. Point `GIWACARD_VAULT_ADDRESS` at the CardVault
proxy.

## Confirmed live

```
gUSD name()          "GiwaCard USD"
gUSD decimals()      6
vault paymentToken() 0xADA0466303441102cb16F8eC1594C744d603f746
vault owner()        0x56A2950ddE6B1040d1DCC4b4C4Fc314Bd56eFB0E
ERC-1967 impl slot   0x0D7766158f14ad7bB82d9FD8A47734e801E3F5B8
```


## First end-to-end run

2026-08-06. Onboarding, mint, merchant-submitted charge, product delivery and
escrow release, all against this deployment.

| Step | Transaction |
| --- | --- |
| Deposit 50 gUSD | [`0x921ac50e…f9609a79`](https://sepolia-explorer.giwa.io/tx/0x921ac50ea000ad743961a7bbd81449f95e4e2ce868e9151b860aac5cf9609a79) |
| Register session policy | [`0xc88c718a…3d2426df`](https://sepolia-explorer.giwa.io/tx/0xc88c718a64ed5b39212f5fe70da8a72826d742bd3bccd8943e024dcd3d2426df) |
| **Mint card 1** (cap 5 gUSD) | [`0x36c3aa76…cfd9602a`](https://sepolia-explorer.giwa.io/tx/0x36c3aa762f7901cda9a3dce7d1c80494cc256ce1b79bc8d196eb3064cfd9602a) |
| **Charge card 1** (1 gUSD taken, 4 released) | [`0x0a9fb47c…a4a51958`](https://sepolia-explorer.giwa.io/tx/0x0a9fb47c699f58bd261476d08d050fda1fac78843e6470783457ff55a4a51958) |
| Cancel card 2, escrow released | [`0x8e6e4447…49c3afa05`](https://sepolia-explorer.giwa.io/tx/0x8e6e4447f414e1d4cf37eae2c5a150abd0e3c890ffdaad0c06517d549c3afa05) |

The charge's `from` is `0x500923476cb40e97957f9eF70a35a6D25E43b6cA`, the
merchant — not the session key. That is the whole payment direction, visible on
chain rather than argued for.

Also observed, and worth knowing before you demo: **the public RPC serves stale
reads for roughly a second after a write.** The escrow that a mint creates reads
as zero if you look immediately; it appeared at 3811ms in this run. And while
`latest` showed the new balance straight away, `safe` and `finalized` still read
zero — `finalized` does not answer on this chain at all.

## Live services

| Service | URL |
| --- | --- |
| Landing page | https://agentcard-eta.vercel.app |
| Owner dashboard | https://agentcard-fe.vercel.app |
| Demo merchant (GIWA Insights) | https://agentcard-production.up.railway.app |

Merchant address: `0x500923476cb40e97957f9eF70a35a6D25E43b6cA` — it submits the
charge itself, so it holds ETH for gas. Keep it topped up; the endpoint answers
503 rather than crashing when it runs dry.

**The dashboard's approval queue does not work on Vercel**, by design. It reads
the daemon through a same-origin route that opens a 0600 token file on the same
machine, and there is no such machine on a serverless host. Balance, cards,
history and session keys all work — they read the chain from the browser.
Approving stays a local action: `giwacard approve`.

## Cost

The whole deployment cost **0.0000102 ETH** — GIWA's gas price was 0.001 gwei
against roughly 10.2M gas. Earlier planning documents guessed ~0.002 ETH for this
step, which overstated it by two orders of magnitude. Budget the demo from this
number, not from the estimate.

## Upgrading

`_authorizeUpgrade` is `onlyOwner`, so the admin key above is the only one that
can upgrade either contract. Use `Upgrades.upgradeProxy` from
`openzeppelin-foundry-upgrades` so storage-layout validation runs; deploying a new
implementation by hand skips it. Storage is append-only behind `__gap`.

Before mainnet, that admin should be a multisig or a timelock, not a single EOA —
whoever holds it can push an implementation that drains every owner's escrow.
