# GIWA Sepolia deployment

Chain 91342. Deployed 2026-08-02.

| Contract | Address |
| --- | --- |
| CardVault (proxy) | [`0xD89395Df78aaFdF86b330899d1C6189211e88750`](https://sepolia-explorer.giwa.io/address/0xD89395Df78aaFdF86b330899d1C6189211e88750) |
| CardVault (implementation) | [`0x0D7766158f14ad7bB82d9FD8A47734e801E3F5B8`](https://sepolia-explorer.giwa.io/address/0x0D7766158f14ad7bB82d9FD8A47734e801E3F5B8) |
| gUSD (proxy) | [`0xADa0466303441102cb16F8Ec1594C744d603F746`](https://sepolia-explorer.giwa.io/address/0xADa0466303441102cb16F8Ec1594C744d603F746) |
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
vault paymentToken() 0xADa0466303441102cb16F8Ec1594C744d603F746
vault owner()        0x56A2950ddE6B1040d1DCC4b4C4Fc314Bd56eFB0E
ERC-1967 impl slot   0x0D7766158f14ad7bB82d9FD8A47734e801E3F5B8
```

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
