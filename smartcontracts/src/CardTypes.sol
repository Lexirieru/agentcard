// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @notice Lifecycle of a GiwaCard card.
 *
 * @dev A card is minted `Active` and leaves that state exactly once, which is what gives the
 * protocol its replay protection: there is no nonce bitmap, the status *is* the nonce.
 *
 * - `None`     card id was never minted.
 * - `Active`   escrow is locked and the card can still be charged.
 * - `Used`     the card was charged; escrow was settled and the remainder released.
 * - `Expired`  the card outlived its expiry and someone reaped it via `releaseExpired`.
 * - `Revoked`  the vault owner cancelled the card before it was charged.
 */
enum CardStatus {
    None,
    Active,
    Used,
    Expired,
    Revoked
}

/**
 * @notice An onchain, one-time spend authorization backed by escrowed vault funds.
 * @param vaultOwner Vault user whose balance backs the card and receives the unspent remainder.
 * @param agent Address the card was minted for; the session key, or the agent named in an
 * owner-signed approval. Informational — charging is gated on `merchantScope`, not on `agent`.
 * @param token ERC20 the card settles in. Always the vault's payment token.
 * @param cap Maximum chargeable amount, in token base units. Escrowed in full at mint.
 * @param merchantScope The only address allowed to charge the card. `address(0)` means any
 * address may charge it, and is only reachable through the owner-signed path.
 * @param expiry Unix timestamp after which the card can no longer be charged and its escrow
 * becomes reapable by anyone.
 * @param status Current lifecycle state.
 */
struct Card {
    address vaultOwner;
    address agent;
    address token;
    uint256 cap;
    address merchantScope;
    uint64 expiry;
    CardStatus status;
}

/**
 * @notice Spending policy attached to one session key of one vault owner.
 * @param capPerCard Largest `cap` a single card minted with this key may carry.
 * @param dailyCap Largest total of card caps this key may mint within one UTC day
 * (`block.timestamp / 86400`), evaluated at mint time and never refunded by cancellation.
 * @param maxExpiry Longest lifetime, in seconds, a card minted with this key may have;
 * a mint must satisfy `expiry <= block.timestamp + maxExpiry`.
 * @param active False once the key is revoked. Revocation is immediate and does not touch
 * cards the key already minted.
 */
struct SessionPolicy {
    uint256 capPerCard;
    uint256 dailyCap;
    uint64 maxExpiry;
    bool active;
}

/**
 * @notice EIP-712 payload letting a vault owner authorize a card that breaks session policy.
 * @dev The vault address and chain id are bound by the EIP-712 domain separator rather than by
 * struct fields. Anyone may relay a signed approval; `approvalId` is what stops replays.
 * @param vaultOwner Vault user who signs and whose balance backs the card.
 * @param agent Address the card is minted for.
 * @param token ERC20 the card settles in. Must equal the vault's payment token.
 * @param cap Maximum chargeable amount, in token base units.
 * @param merchantScope Address allowed to charge the card; `address(0)` for an open card.
 * @param expiry Unix timestamp after which the card can no longer be charged.
 * @param approvalId Single-use identifier, unique per vault owner.
 */
struct CardApproval {
    address vaultOwner;
    address agent;
    address token;
    uint256 cap;
    address merchantScope;
    uint64 expiry;
    bytes32 approvalId;
}
