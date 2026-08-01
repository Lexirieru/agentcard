// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {Card, CardApproval, CardStatus, SessionPolicy} from "./CardTypes.sol";

/**
 * @title CardVault
 * @notice The GiwaCard vault: custody, session keys and one-time spend cards for AI agents.
 *
 * @dev One canonical multi-owner instance serves every user. Balances, escrow, session keys and
 * cards are all keyed by *vault owner* address; there is no vault-per-user deployment.
 *
 * Two words that look alike are deliberately kept apart in this contract:
 * - the **contract owner** (`owner()`, from {OwnableUpgradeable}) is the protocol admin and may
 *   only authorize UUPS upgrades;
 * - a **vault owner** is an end user who deposited funds and whose agents spend them.
 *
 * The spend flow is: the vault owner deposits gUSD and registers a session key (an EOA held by
 * the agent's MCP server) with a policy. Within policy the agent mints a card itself, which
 * locks escrow; outside policy the vault owner signs an EIP-712 {CardApproval} offchain that
 * anyone may relay. A card is charged exactly once by its scoped merchant, after which the
 * charged amount leaves the balance and the unspent remainder returns to available funds.
 *
 * Escrow uses a single per-owner accumulator: `availableBalance = balance - escrowedTotal`, with
 * `escrowedTotal` moved up by mints and down by charges, cancellations and expiry reaps. Active
 * cards are never summed over. Because the EVM cannot self-trigger at a deadline, the escrow of
 * an expired card is freed by the permissionless {releaseExpired}.
 */
contract CardVault is OwnableUpgradeable, UUPSUpgradeable, EIP712Upgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;

    /// @dev Length of the rolling window used by `dailyCap`, i.e. the UTC day.
    uint256 private constant _DAY = 1 days;

    /// @dev EIP-712 type hash of {CardApproval}. Must mirror the struct field order exactly.
    bytes32 private constant _CARD_APPROVAL_TYPEHASH = keccak256(
        "CardApproval(address vaultOwner,address agent,address token,uint256 cap,address merchantScope,uint64 expiry,bytes32 approvalId)"
    );

    /// @dev The only ERC20 this vault custodies and settles cards in.
    address private _paymentToken;

    /// @dev Id of the most recently minted card. Card ids start at 1, so 0 is never a real card.
    uint256 private _lastCardId;

    /// @dev Total tokens each vault owner has deposited and not yet withdrawn or spent.
    mapping(address vaultOwner => uint256 amount) private _balances;

    /// @dev Sum of the caps of every still-Active card of a vault owner. Single accumulator.
    mapping(address vaultOwner => uint256 amount) private _escrowedTotals;

    /// @dev Policy per (vault owner, session key). `active == false` means unregistered or revoked.
    mapping(address vaultOwner => mapping(address sessionKey => SessionPolicy policy)) private _policies;

    /// @dev Merchant allowlist per (vault owner, session key). Deny by default.
    mapping(address vaultOwner => mapping(address sessionKey => mapping(address merchant => bool allowed))) private
        _merchantAllowlist;

    /// @dev Sum of card caps minted per (vault owner, session key, UTC day index).
    mapping(address vaultOwner => mapping(address sessionKey => mapping(uint256 day => uint256 amount))) private
        _mintedOnDay;

    /// @dev Every card ever minted, by id.
    mapping(uint256 cardId => Card card) private _cards;

    /// @dev Consumed one-time approval ids, per signing vault owner.
    mapping(address vaultOwner => mapping(bytes32 approvalId => bool used)) private _usedApprovals;

    /// @dev Reserved storage so future versions can append state without shifting this layout.
    uint256[42] private __gap;

    /// @notice Emitted when `vaultOwner` deposits `amount` of the payment token.
    event Deposited(address indexed vaultOwner, uint256 amount);

    /// @notice Emitted when `vaultOwner` withdraws `amount` of the payment token to `to`.
    event Withdrawn(address indexed vaultOwner, address indexed to, uint256 amount);

    /// @notice Emitted when `vaultOwner` registers or re-registers `sessionKey` with a policy.
    event SessionKeyRegistered(
        address indexed vaultOwner, address indexed sessionKey, uint256 capPerCard, uint256 dailyCap, uint64 maxExpiry
    );

    /// @notice Emitted whenever a merchant is added to or removed from a session key's allowlist.
    event SessionKeyMerchantSet(
        address indexed vaultOwner, address indexed sessionKey, address indexed merchant, bool allowed
    );

    /// @notice Emitted when `vaultOwner` revokes `sessionKey`. Already-minted cards are unaffected.
    event SessionKeyRevoked(address indexed vaultOwner, address indexed sessionKey);

    /// @notice Emitted when a card is minted and its `cap` is escrowed.
    event CardMinted(
        uint256 indexed cardId,
        address indexed vaultOwner,
        address indexed agent,
        address token,
        uint256 cap,
        address merchantScope,
        uint64 expiry
    );

    /// @notice Emitted when a card is charged; `released` is the unspent cap returned to available.
    event CardCharged(
        uint256 indexed cardId, address indexed vaultOwner, address indexed merchant, uint256 amount, uint256 released
    );

    /// @notice Emitted when a vault owner cancels an active card and its escrow is released.
    event CardCancelled(uint256 indexed cardId, address indexed vaultOwner, uint256 released);

    /// @notice Emitted when anyone reaps an expired card and its escrow is released.
    event CardExpiredReleased(
        uint256 indexed cardId, address indexed vaultOwner, address indexed caller, uint256 released
    );

    /// @notice Emitted when a one-time owner approval id is consumed by a signed mint.
    event ApprovalConsumed(address indexed vaultOwner, bytes32 indexed approvalId, uint256 indexed cardId);

    /// @notice Thrown when an address argument that must be non-zero is zero.
    error ZeroAddress();

    /// @notice Thrown when an amount that must be non-zero is zero.
    error ZeroAmount();

    /// @notice Thrown when a signed approval names a token this vault does not settle in.
    error UnsupportedToken(address token);

    /// @notice Thrown when a vault owner's unescrowed balance cannot cover the operation.
    error InsufficientAvailableBalance(uint256 available, uint256 required);

    /// @notice Thrown when the caller is not a registered, unrevoked session key of the vault owner.
    error SessionKeyNotActive(address vaultOwner, address sessionKey);

    /// @notice Thrown when a requested card cap exceeds the session key's per-card cap.
    error CapPerCardExceeded(uint256 cap, uint256 limit);

    /// @notice Thrown when a mint would push the session key past its cap for the current UTC day.
    error DailyCapExceeded(uint256 wouldBeTotal, uint256 limit);

    /// @notice Thrown when a session key mints outside its merchant allowlist.
    error MerchantNotAllowed(address vaultOwner, address sessionKey, address merchant);

    /// @notice Thrown when a card would be minted already expired.
    error ExpiryInPast(uint64 expiry);

    /// @notice Thrown when a card's expiry is further out than the session key's `maxExpiry`.
    error ExpiryTooFar(uint64 expiry, uint256 latestAllowed);

    /// @notice Thrown when an operation needs an `Active` card and the card is in another state.
    error CardNotActive(uint256 cardId, CardStatus status);

    /// @notice Thrown when a card is charged after its expiry.
    error CardExpired(uint256 cardId, uint64 expiry);

    /// @notice Thrown when {releaseExpired} is called on a card that has not expired yet.
    error CardNotExpired(uint256 cardId, uint64 expiry);

    /// @notice Thrown when someone other than the card's vault owner tries to cancel it.
    error NotCardOwner(uint256 cardId, address caller, address vaultOwner);

    /// @notice Thrown when the caller is not the merchant a card is scoped to.
    error MerchantScopeMismatch(uint256 cardId, address caller, address merchantScope);

    /// @notice Thrown when a charge exceeds the card's cap.
    error ChargeExceedsCap(uint256 amount, uint256 cap);

    /// @notice Thrown when an owner approval carries a signature the vault owner did not produce.
    error InvalidSignature();

    /// @notice Thrown when an owner approval reuses an already-consumed `approvalId`.
    error ApprovalAlreadyUsed(address vaultOwner, bytes32 approvalId);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the proxy with its admin and the ERC20 every card settles in.
     * @param initialOwner Protocol admin; the only address allowed to authorize upgrades.
     * @param paymentToken_ ERC20 custodied by the vault, i.e. gUSD.
     */
    function initialize(address initialOwner, address paymentToken_) external initializer {
        if (paymentToken_ == address(0)) {
            revert ZeroAddress();
        }

        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();
        __EIP712_init("GiwaCard CardVault", "1");
        __ReentrancyGuard_init();

        _paymentToken = paymentToken_;
    }

    /*//////////////////////////////////////////////////////////////
                                CUSTODY
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Deposits `amount` of the payment token into the caller's vault balance.
     * @dev The caller must have approved the vault for at least `amount` beforehand.
     * @param amount Amount to deposit, in token base units.
     */
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) {
            revert ZeroAmount();
        }

        _balances[msg.sender] += amount;
        emit Deposited(msg.sender, amount);

        IERC20(_paymentToken).safeTransferFrom(msg.sender, address(this), amount);
    }

    /**
     * @notice Withdraws `amount` of the payment token from the caller's available balance.
     * @dev Escrowed funds are untouchable: only `balance - escrowedTotal` can leave.
     * @param amount Amount to withdraw, in token base units.
     * @param to Recipient of the tokens.
     */
    function withdraw(uint256 amount, address to) external nonReentrant {
        if (amount == 0) {
            revert ZeroAmount();
        }
        if (to == address(0)) {
            revert ZeroAddress();
        }

        uint256 available = availableBalanceOf(msg.sender);
        if (available < amount) {
            revert InsufficientAvailableBalance(available, amount);
        }

        _balances[msg.sender] -= amount;
        emit Withdrawn(msg.sender, to, amount);

        IERC20(_paymentToken).safeTransfer(to, amount);
    }

    /*//////////////////////////////////////////////////////////////
                              SESSION KEYS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Registers (or re-registers) `sessionKey` under the caller's vault owner namespace.
     * @dev Re-registration overwrites the policy and reactivates a revoked key. Merchants passed
     * here are *added* to the allowlist; entries already present are never cleared, so use
     * {setSessionKeyMerchant} to remove one.
     * @param sessionKey EOA the agent signs transactions with.
     * @param capPerCard Largest cap a single card minted by this key may carry.
     * @param dailyCap Largest total of card caps this key may mint within one UTC day.
     * @param maxExpiry Longest card lifetime, in seconds, this key may request.
     * @param merchants Merchants to add to this key's allowlist.
     */
    function registerSessionKey(
        address sessionKey,
        uint256 capPerCard,
        uint256 dailyCap,
        uint64 maxExpiry,
        address[] calldata merchants
    ) external {
        if (sessionKey == address(0)) {
            revert ZeroAddress();
        }

        _policies[msg.sender][sessionKey] =
            SessionPolicy({capPerCard: capPerCard, dailyCap: dailyCap, maxExpiry: maxExpiry, active: true});
        emit SessionKeyRegistered(msg.sender, sessionKey, capPerCard, dailyCap, maxExpiry);

        for (uint256 i = 0; i < merchants.length; ++i) {
            _setSessionKeyMerchant(sessionKey, merchants[i], true);
        }
    }

    /**
     * @notice Adds or removes a merchant from one of the caller's session key allowlists.
     * @param sessionKey Session key whose allowlist is edited.
     * @param merchant Merchant address to toggle.
     * @param allowed True to allow, false to deny.
     */
    function setSessionKeyMerchant(address sessionKey, address merchant, bool allowed) external {
        _setSessionKeyMerchant(sessionKey, merchant, allowed);
    }

    /**
     * @notice Revokes `sessionKey` for the caller, effective immediately.
     * @dev Cards the key already minted stay `Active`; cancel them individually with {cancelCard}.
     * @param sessionKey Session key to revoke.
     */
    function revokeSessionKey(address sessionKey) external {
        _policies[msg.sender][sessionKey].active = false;
        emit SessionKeyRevoked(msg.sender, sessionKey);
    }

    /*//////////////////////////////////////////////////////////////
                                 CARDS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Mints a card within the caller's session policy and escrows its cap.
     * @dev The caller *is* the session key, so no signature is checked here: a signature would
     * verify nothing that `msg.sender` does not already prove.
     * @param vaultOwner Vault owner whose funds back the card.
     * @param cap Maximum chargeable amount, in token base units.
     * @param merchantScope Merchant allowed to charge the card. Must be on the key's allowlist.
     * @param expiry Unix timestamp after which the card can no longer be charged.
     * @return cardId Id of the freshly minted card.
     */
    function mintCard(address vaultOwner, uint256 cap, address merchantScope, uint64 expiry)
        external
        nonReentrant
        returns (uint256 cardId)
    {
        SessionPolicy storage policy = _policies[vaultOwner][msg.sender];
        if (!policy.active) {
            revert SessionKeyNotActive(vaultOwner, msg.sender);
        }
        if (cap > policy.capPerCard) {
            revert CapPerCardExceeded(cap, policy.capPerCard);
        }
        if (merchantScope == address(0) || !_merchantAllowlist[vaultOwner][msg.sender][merchantScope]) {
            revert MerchantNotAllowed(vaultOwner, msg.sender, merchantScope);
        }

        uint256 latestAllowed = block.timestamp + policy.maxExpiry;
        if (expiry > latestAllowed) {
            revert ExpiryTooFar(expiry, latestAllowed);
        }

        uint256 day = currentDay();
        uint256 wouldBeTotal = _mintedOnDay[vaultOwner][msg.sender][day] + cap;
        if (wouldBeTotal > policy.dailyCap) {
            revert DailyCapExceeded(wouldBeTotal, policy.dailyCap);
        }
        _mintedOnDay[vaultOwner][msg.sender][day] = wouldBeTotal;

        cardId = _mintCard(vaultOwner, msg.sender, cap, merchantScope, expiry);
    }

    /**
     * @notice Mints a card from a vault owner's offchain EIP-712 approval, bypassing session policy.
     * @dev Anyone may relay the approval; `approvalId` is what makes it single-use. The signature
     * is bound to this proxy and chain id through the EIP-712 domain separator.
     * @param approval The signed card parameters.
     * @param signature EIP-712 signature by `approval.vaultOwner` (EOA or ERC-1271 contract).
     * @return cardId Id of the freshly minted card.
     */
    function mintCardWithApproval(CardApproval calldata approval, bytes calldata signature)
        external
        nonReentrant
        returns (uint256 cardId)
    {
        if (approval.token != _paymentToken) {
            revert UnsupportedToken(approval.token);
        }
        if (_usedApprovals[approval.vaultOwner][approval.approvalId]) {
            revert ApprovalAlreadyUsed(approval.vaultOwner, approval.approvalId);
        }
        if (!SignatureChecker.isValidSignatureNow(approval.vaultOwner, hashCardApproval(approval), signature)) {
            revert InvalidSignature();
        }

        _usedApprovals[approval.vaultOwner][approval.approvalId] = true;

        cardId = _mintCard(approval.vaultOwner, approval.agent, approval.cap, approval.merchantScope, approval.expiry);
        emit ApprovalConsumed(approval.vaultOwner, approval.approvalId, cardId);
    }

    /**
     * @notice Charges `amount` from card `cardId` to the calling merchant, once and for all.
     * @dev The card must still be `Active` and unexpired; it flips to `Used` before the transfer,
     * so a replay hits {CardNotActive}. The unspent `cap - amount` returns to available balance.
     * @param cardId Card to charge.
     * @param amount Amount to pull, in token base units. Must be non-zero and at most the cap.
     */
    function charge(uint256 cardId, uint256 amount) external nonReentrant {
        Card storage card = _cards[cardId];

        if (card.status != CardStatus.Active) {
            revert CardNotActive(cardId, card.status);
        }
        if (block.timestamp > card.expiry) {
            revert CardExpired(cardId, card.expiry);
        }
        if (card.merchantScope != address(0) && card.merchantScope != msg.sender) {
            revert MerchantScopeMismatch(cardId, msg.sender, card.merchantScope);
        }
        if (amount == 0) {
            revert ZeroAmount();
        }
        if (amount > card.cap) {
            revert ChargeExceedsCap(amount, card.cap);
        }

        address vaultOwner = card.vaultOwner;
        uint256 cap = card.cap;

        card.status = CardStatus.Used;
        _escrowedTotals[vaultOwner] -= cap;
        _balances[vaultOwner] -= amount;

        emit CardCharged(cardId, vaultOwner, msg.sender, amount, cap - amount);

        IERC20(_paymentToken).safeTransfer(msg.sender, amount);
    }

    /**
     * @notice Cancels an active card of the caller and releases its escrow.
     * @param cardId Card to cancel.
     */
    function cancelCard(uint256 cardId) external {
        Card storage card = _cards[cardId];

        if (card.status != CardStatus.Active) {
            revert CardNotActive(cardId, card.status);
        }
        if (card.vaultOwner != msg.sender) {
            revert NotCardOwner(cardId, msg.sender, card.vaultOwner);
        }

        card.status = CardStatus.Revoked;
        _escrowedTotals[msg.sender] -= card.cap;

        emit CardCancelled(cardId, msg.sender, card.cap);
    }

    /**
     * @notice Releases the escrow of an expired card. Permissionless.
     * @dev The EVM has no time-triggered execution, so expiry is a state anyone may realise.
     * @param cardId Card to reap.
     */
    function releaseExpired(uint256 cardId) external {
        Card storage card = _cards[cardId];

        if (card.status != CardStatus.Active) {
            revert CardNotActive(cardId, card.status);
        }
        if (block.timestamp <= card.expiry) {
            revert CardNotExpired(cardId, card.expiry);
        }

        address vaultOwner = card.vaultOwner;

        card.status = CardStatus.Expired;
        _escrowedTotals[vaultOwner] -= card.cap;

        emit CardExpiredReleased(cardId, vaultOwner, msg.sender, card.cap);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice ERC20 this vault custodies and settles every card in.
    function paymentToken() external view returns (address) {
        return _paymentToken;
    }

    /// @notice Total amount `vaultOwner` has deposited, including funds locked in escrow.
    function balanceOf(address vaultOwner) external view returns (uint256) {
        return _balances[vaultOwner];
    }

    /// @notice Sum of the caps of `vaultOwner`'s still-active cards.
    function escrowedOf(address vaultOwner) external view returns (uint256) {
        return _escrowedTotals[vaultOwner];
    }

    /// @notice Funds of `vaultOwner` that are neither escrowed nor spent: `balance - escrowed`.
    function availableBalanceOf(address vaultOwner) public view returns (uint256) {
        return _balances[vaultOwner] - _escrowedTotals[vaultOwner];
    }

    /// @notice Full record of card `cardId`. A never-minted id reads back with status `None`.
    function getCard(uint256 cardId) external view returns (Card memory) {
        return _cards[cardId];
    }

    /// @notice Id of the most recently minted card; 0 before the first mint.
    function lastCardId() external view returns (uint256) {
        return _lastCardId;
    }

    /// @notice Policy `vaultOwner` attached to `sessionKey`. `active` is false once revoked.
    function sessionPolicy(address vaultOwner, address sessionKey) external view returns (SessionPolicy memory) {
        return _policies[vaultOwner][sessionKey];
    }

    /// @notice Whether `sessionKey` of `vaultOwner` may scope cards to `merchant`.
    function isMerchantAllowed(address vaultOwner, address sessionKey, address merchant) external view returns (bool) {
        return _merchantAllowlist[vaultOwner][sessionKey][merchant];
    }

    /// @notice Total card caps `sessionKey` minted for `vaultOwner` during UTC day index `day`.
    function mintedOnDay(address vaultOwner, address sessionKey, uint256 day) external view returns (uint256) {
        return _mintedOnDay[vaultOwner][sessionKey][day];
    }

    /// @notice UTC day index of the current block, i.e. `block.timestamp / 86400`.
    function currentDay() public view returns (uint256) {
        return block.timestamp / _DAY;
    }

    /// @notice Whether `vaultOwner` already spent the one-time `approvalId`.
    function isApprovalUsed(address vaultOwner, bytes32 approvalId) external view returns (bool) {
        return _usedApprovals[vaultOwner][approvalId];
    }

    /**
     * @notice EIP-712 digest a vault owner must sign to authorize an over-policy card.
     * @param approval Approval to hash.
     * @return The typed-data digest, bound to this proxy address and chain id.
     */
    function hashCardApproval(CardApproval memory approval) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    _CARD_APPROVAL_TYPEHASH,
                    approval.vaultOwner,
                    approval.agent,
                    approval.token,
                    approval.cap,
                    approval.merchantScope,
                    approval.expiry,
                    approval.approvalId
                )
            )
        );
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNAL
    //////////////////////////////////////////////////////////////*/

    /// @dev Shared mint tail: validates funds, locks escrow and writes the card record.
    function _mintCard(address vaultOwner, address agent, uint256 cap, address merchantScope, uint64 expiry)
        private
        returns (uint256 cardId)
    {
        if (vaultOwner == address(0)) {
            revert ZeroAddress();
        }
        if (cap == 0) {
            revert ZeroAmount();
        }
        if (expiry <= block.timestamp) {
            revert ExpiryInPast(expiry);
        }

        uint256 available = availableBalanceOf(vaultOwner);
        if (available < cap) {
            revert InsufficientAvailableBalance(available, cap);
        }

        _escrowedTotals[vaultOwner] += cap;

        cardId = ++_lastCardId;
        _cards[cardId] = Card({
            vaultOwner: vaultOwner,
            agent: agent,
            token: _paymentToken,
            cap: cap,
            merchantScope: merchantScope,
            expiry: expiry,
            status: CardStatus.Active
        });

        emit CardMinted(cardId, vaultOwner, agent, _paymentToken, cap, merchantScope, expiry);
    }

    /// @dev Writes one allowlist entry for the caller's session key and emits the change.
    function _setSessionKeyMerchant(address sessionKey, address merchant, bool allowed) private {
        if (sessionKey == address(0) || merchant == address(0)) {
            revert ZeroAddress();
        }

        _merchantAllowlist[msg.sender][sessionKey][merchant] = allowed;
        emit SessionKeyMerchantSet(msg.sender, sessionKey, merchant, allowed);
    }

    /// @dev Restricts UUPS upgrades to the protocol admin; the new implementation is not inspected.
    function _authorizeUpgrade(address) internal override onlyOwner {}
}
