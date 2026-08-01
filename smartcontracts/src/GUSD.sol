// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title GUSD
 * @notice GiwaCard USD (`gUSD`) — the test stablecoin every GiwaCard demo transacts in.
 *
 * @dev GIWA Sepolia has no canonical test USDC, so GiwaCard ships its own. The token mirrors
 * USDC's 6 decimals so amounts, price feeds and UI formatting carry over unchanged.
 *
 * Anyone can self-serve test liquidity through the onchain faucet: {claimFaucet} mints
 * {FAUCET_AMOUNT} to the caller, at most once per {FAUCET_COOLDOWN} per address.
 *
 * The contract is UUPS upgradeable. Storage is append-only and a `__gap` is reserved so future
 * versions can add state without disturbing the layout of contracts that inherit from this one.
 */
contract GUSD is ERC20Upgradeable, OwnableUpgradeable, UUPSUpgradeable {
    /// @dev Token decimals. Matches USDC so that integrations can treat gUSD as a drop-in.
    uint8 private constant _DECIMALS = 6;

    /// @notice Amount of gUSD minted by a single successful faucet claim (100 gUSD).
    uint256 public constant FAUCET_AMOUNT = 100 * 10 ** _DECIMALS;

    /// @notice Minimum time an address must wait between two faucet claims.
    uint256 public constant FAUCET_COOLDOWN = 24 hours;

    /// @dev Timestamp of the last successful faucet claim per address. Zero means "never claimed".
    mapping(address account => uint256 timestamp) private _lastFaucetClaim;

    /// @dev Reserved storage so this contract can gain state without shifting child layouts.
    uint256[49] private __gap;

    /// @notice Emitted when `account` successfully claims `amount` from the faucet.
    event FaucetClaimed(address indexed account, uint256 amount);

    /// @notice Thrown when an address claims from the faucet before its cooldown has elapsed.
    /// @param availableAt Timestamp at which the caller may claim again.
    error FaucetCooldownActive(uint256 availableAt);

    /// @notice Thrown when tokens would be minted to the zero address.
    error InvalidRecipient();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the proxy with the gUSD metadata and its owner.
     * @dev Callable exactly once, on the proxy only; the implementation's initializers are
     * disabled in the constructor.
     * @param initialOwner Address granted ownership, i.e. minting and upgrade authority.
     */
    function initialize(address initialOwner) external initializer {
        __ERC20_init("GiwaCard USD", "gUSD");
        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();
    }

    /**
     * @notice Number of decimals used to get the token's user representation.
     * @return Always 6, for parity with USDC.
     */
    function decimals() public pure override returns (uint8) {
        return _DECIMALS;
    }

    /**
     * @notice Mints {FAUCET_AMOUNT} of gUSD to the caller.
     * @dev Reverts with {FaucetCooldownActive} if the caller claimed less than
     * {FAUCET_COOLDOWN} ago. Each address has its own independent cooldown.
     */
    function claimFaucet() external {
        uint256 availableAt = faucetAvailableAt(msg.sender);
        if (block.timestamp < availableAt) {
            revert FaucetCooldownActive(availableAt);
        }

        _lastFaucetClaim[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);

        emit FaucetClaimed(msg.sender, FAUCET_AMOUNT);
    }

    /**
     * @notice Timestamp of `account`'s last successful faucet claim.
     * @param account Address to query.
     * @return Unix timestamp of the last claim, or 0 if `account` never claimed.
     */
    function lastFaucetClaim(address account) external view returns (uint256) {
        return _lastFaucetClaim[account];
    }

    /**
     * @notice Earliest timestamp at which `account` may claim from the faucet.
     * @param account Address to query.
     * @return Unix timestamp, or 0 if `account` has never claimed and may claim immediately.
     */
    function faucetAvailableAt(address account) public view returns (uint256) {
        uint256 last = _lastFaucetClaim[account];
        if (last == 0) {
            return 0;
        }
        return last + FAUCET_COOLDOWN;
    }

    /**
     * @notice Mints `amount` of gUSD to `to`, bypassing the faucet cooldown.
     * @dev Owner-only escape hatch for seeding demo accounts and agent treasuries.
     * @param to Recipient of the newly minted tokens.
     * @param amount Amount to mint, in base units (6 decimals).
     */
    function mint(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) {
            revert InvalidRecipient();
        }
        _mint(to, amount);
    }

    /// @dev Restricts UUPS upgrades to the owner; the new implementation address is not inspected.
    function _authorizeUpgrade(address) internal override onlyOwner {}
}
