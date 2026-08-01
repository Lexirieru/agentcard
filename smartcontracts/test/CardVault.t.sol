// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Upgrades} from "openzeppelin-foundry-upgrades/Upgrades.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {CardVault} from "../src/CardVault.sol";
import {Card, CardApproval, CardStatus, SessionPolicy} from "../src/CardTypes.sol";
import {GUSD} from "../src/GUSD.sol";

/**
 * @dev Test-only V2 of {CardVault}. Appends state after the inherited `__gap` so the upgrade test
 * can prove that vault balances, escrow and card records survive an implementation swap.
 * @custom:oz-upgrades-from CardVault
 */
contract CardVaultV2 is CardVault {
    /// @notice New state appended by V2.
    uint256 public protocolFeeBps;

    /// @notice Initializes the V2-only state during the upgrade call.
    /// @custom:oz-upgrades-validate-as-initializer
    /// @custom:oz-upgrades-unsafe-allow missing-initializer-call
    function initializeV2(uint256 bps) external reinitializer(2) {
        protocolFeeBps = bps;
    }

    /// @notice Marker used to assert that the proxy now runs V2 code.
    function version() external pure returns (string memory) {
        return "2";
    }
}

contract CardVaultTest is Test {
    GUSD internal gusd;
    CardVault internal vault;

    address internal admin = makeAddr("admin");
    address internal merchant = makeAddr("merchant");
    address internal otherMerchant = makeAddr("otherMerchant");
    address internal relayer = makeAddr("relayer");

    address internal alice;
    uint256 internal alicePk;
    address internal bob;
    uint256 internal bobPk;
    address internal agent;

    uint256 internal constant ONE_GUSD = 1e6;

    event Deposited(address indexed vaultOwner, uint256 amount);
    event Withdrawn(address indexed vaultOwner, address indexed to, uint256 amount);
    event SessionKeyRegistered(
        address indexed vaultOwner, address indexed sessionKey, uint256 capPerCard, uint256 dailyCap, uint64 maxExpiry
    );
    event SessionKeyMerchantSet(
        address indexed vaultOwner, address indexed sessionKey, address indexed merchant, bool allowed
    );
    event SessionKeyRevoked(address indexed vaultOwner, address indexed sessionKey);
    event CardMinted(
        uint256 indexed cardId,
        address indexed vaultOwner,
        address indexed agent,
        address token,
        uint256 cap,
        address merchantScope,
        uint64 expiry
    );
    event CardCharged(
        uint256 indexed cardId, address indexed vaultOwner, address indexed merchant, uint256 amount, uint256 released
    );
    event CardCancelled(uint256 indexed cardId, address indexed vaultOwner, uint256 released);
    event CardExpiredReleased(
        uint256 indexed cardId, address indexed vaultOwner, address indexed caller, uint256 released
    );
    event ApprovalConsumed(address indexed vaultOwner, bytes32 indexed approvalId, uint256 indexed cardId);

    function setUp() public {
        // A realistic timestamp keeps the UTC-day arithmetic away from genesis edge cases.
        vm.warp(1_750_000_000);

        (alice, alicePk) = makeAddrAndKey("alice");
        (bob, bobPk) = makeAddrAndKey("bob");
        agent = makeAddr("agent");

        gusd = GUSD(Upgrades.deployUUPSProxy("GUSD.sol:GUSD", abi.encodeCall(GUSD.initialize, (admin))));
        vault = CardVault(
            Upgrades.deployUUPSProxy(
                "CardVault.sol:CardVault", abi.encodeCall(CardVault.initialize, (admin, address(gusd)))
            )
        );

        vm.startPrank(admin);
        gusd.mint(alice, 1_000 * ONE_GUSD);
        gusd.mint(bob, 1_000 * ONE_GUSD);
        vm.stopPrank();

        vm.prank(alice);
        gusd.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        gusd.approve(address(vault), type(uint256).max);
    }

    /*//////////////////////////////////////////////////////////////
                            ACCEPTANCE EXAMPLES
    //////////////////////////////////////////////////////////////*/

    /// @dev AE1: a 5 gUSD card scoped to a merchant is charged 1 gUSD; 4 gUSD go back to available.
    function test_AE1_ChargeSettlesOnceAndReleasesRemainder() public {
        _deposit(alice, 10 * ONE_GUSD);
        _registerSessionKey(alice, agent, 5 * ONE_GUSD, 100 * ONE_GUSD, 1 days, merchant);

        uint64 expiry = uint64(block.timestamp + 1 hours);
        vm.prank(agent);
        uint256 cardId = vault.mintCard(alice, 5 * ONE_GUSD, merchant, expiry);

        assertEq(vault.balanceOf(alice), 10 * ONE_GUSD);
        assertEq(vault.escrowedOf(alice), 5 * ONE_GUSD);
        assertEq(vault.availableBalanceOf(alice), 5 * ONE_GUSD);

        vm.expectEmit(true, true, true, true, address(vault));
        emit CardCharged(cardId, alice, merchant, ONE_GUSD, 4 * ONE_GUSD);
        vm.prank(merchant);
        vault.charge(cardId, ONE_GUSD);

        assertEq(gusd.balanceOf(merchant), ONE_GUSD);
        assertEq(gusd.balanceOf(address(vault)), 9 * ONE_GUSD);
        assertEq(vault.balanceOf(alice), 9 * ONE_GUSD);
        assertEq(vault.escrowedOf(alice), 0);
        assertEq(vault.availableBalanceOf(alice), 9 * ONE_GUSD);
        assertEq(uint8(vault.getCard(cardId).status), uint8(CardStatus.Used));

        vm.expectRevert(abi.encodeWithSelector(CardVault.CardNotActive.selector, cardId, CardStatus.Used));
        vm.prank(merchant);
        vault.charge(cardId, ONE_GUSD);
    }

    /// @dev AE3: a used card cannot be charged again, not even for a different amount.
    function test_AE3_UsedCardCannotBeReplayed() public {
        uint256 cardId = _mintInPolicyCard(alice, 5 * ONE_GUSD, merchant);

        vm.prank(merchant);
        vault.charge(cardId, 2 * ONE_GUSD);

        vm.expectRevert(abi.encodeWithSelector(CardVault.CardNotActive.selector, cardId, CardStatus.Used));
        vm.prank(merchant);
        vault.charge(cardId, ONE_GUSD);

        vm.expectRevert(abi.encodeWithSelector(CardVault.CardNotActive.selector, cardId, CardStatus.Used));
        vm.prank(merchant);
        vault.charge(cardId, 3 * ONE_GUSD);

        // The single charge stands: balance moved once, escrow is fully released.
        assertEq(gusd.balanceOf(merchant), 2 * ONE_GUSD);
        assertEq(vault.balanceOf(alice), 8 * ONE_GUSD);
        assertEq(vault.escrowedOf(alice), 0);
    }

    /// @dev AE5: escrow, not balance, gates the second mint.
    function test_AE5_SecondMintBlockedUntilFirstCardDies() public {
        _deposit(alice, 10 * ONE_GUSD);
        _registerSessionKey(alice, agent, 10 * ONE_GUSD, 100 * ONE_GUSD, 1 days, merchant);

        uint64 expiry = uint64(block.timestamp + 1 hours);

        vm.prank(agent);
        uint256 firstCardId = vault.mintCard(alice, 8 * ONE_GUSD, merchant, expiry);
        assertEq(vault.availableBalanceOf(alice), 2 * ONE_GUSD);

        vm.expectRevert(
            abi.encodeWithSelector(CardVault.InsufficientAvailableBalance.selector, 2 * ONE_GUSD, 5 * ONE_GUSD)
        );
        vm.prank(agent);
        vault.mintCard(alice, 5 * ONE_GUSD, merchant, expiry);

        // Kill the first card; its escrow returns and the second mint now fits.
        vm.prank(alice);
        vault.cancelCard(firstCardId);
        assertEq(vault.availableBalanceOf(alice), 10 * ONE_GUSD);

        vm.prank(agent);
        uint256 secondCardId = vault.mintCard(alice, 5 * ONE_GUSD, merchant, expiry);

        assertEq(uint8(vault.getCard(firstCardId).status), uint8(CardStatus.Revoked));
        assertEq(uint8(vault.getCard(secondCardId).status), uint8(CardStatus.Active));
        assertEq(vault.escrowedOf(alice), 5 * ONE_GUSD);
        assertEq(vault.availableBalanceOf(alice), 5 * ONE_GUSD);
    }

    /// @dev AE7: an off-allowlist merchant is refused to the session key but allowed to the owner.
    function test_AE7_OffAllowlistMerchantNeedsOwnerSignature() public {
        _deposit(alice, 10 * ONE_GUSD);
        _registerSessionKey(alice, agent, 5 * ONE_GUSD, 100 * ONE_GUSD, 1 days, merchant);

        uint64 expiry = uint64(block.timestamp + 1 hours);

        vm.expectRevert(abi.encodeWithSelector(CardVault.MerchantNotAllowed.selector, alice, agent, otherMerchant));
        vm.prank(agent);
        vault.mintCard(alice, 5 * ONE_GUSD, otherMerchant, expiry);

        // The same card, authorized offchain by the vault owner and relayed by a stranger.
        CardApproval memory approval = _approval(alice, agent, 5 * ONE_GUSD, otherMerchant, expiry, "ae7");

        vm.prank(relayer);
        uint256 cardId = vault.mintCardWithApproval(approval, _sign(alicePk, approval));

        Card memory card = vault.getCard(cardId);
        assertEq(card.vaultOwner, alice);
        assertEq(card.agent, agent);
        assertEq(card.merchantScope, otherMerchant);
        assertEq(card.cap, 5 * ONE_GUSD);
        assertEq(card.token, address(gusd));
        assertEq(uint8(card.status), uint8(CardStatus.Active));
        assertEq(vault.escrowedOf(alice), 5 * ONE_GUSD);

        vm.prank(otherMerchant);
        vault.charge(cardId, 3 * ONE_GUSD);
        assertEq(gusd.balanceOf(otherMerchant), 3 * ONE_GUSD);
    }

    /*//////////////////////////////////////////////////////////////
                             INITIALIZATION
    //////////////////////////////////////////////////////////////*/

    function test_InitialState() public view {
        assertEq(vault.owner(), admin);
        assertEq(vault.paymentToken(), address(gusd));
        assertEq(vault.lastCardId(), 0);
        assertEq(vault.balanceOf(alice), 0);
        assertEq(vault.escrowedOf(alice), 0);
        assertEq(vault.availableBalanceOf(alice), 0);
        assertEq(uint8(vault.getCard(1).status), uint8(CardStatus.None));
    }

    function test_InitializeRevertsWhenCalledTwice() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        vault.initialize(admin, address(gusd));
    }

    function test_InitializeRevertsOnImplementation() public {
        address implementation = Upgrades.getImplementationAddress(address(vault));

        vm.expectRevert(Initializable.InvalidInitialization.selector);
        CardVault(implementation).initialize(admin, address(gusd));
    }

    function test_InitializeRevertsForZeroToken() public {
        address implementation = Upgrades.getImplementationAddress(address(vault));

        vm.expectRevert(CardVault.ZeroAddress.selector);
        new ERC1967Proxy(implementation, abi.encodeCall(CardVault.initialize, (admin, address(0))));
    }

    /*//////////////////////////////////////////////////////////////
                            DEPOSIT / WITHDRAW
    //////////////////////////////////////////////////////////////*/

    function test_DepositCreditsBalanceAndMovesTokens() public {
        vm.expectEmit(true, true, true, true, address(vault));
        emit Deposited(alice, 10 * ONE_GUSD);
        _deposit(alice, 10 * ONE_GUSD);

        assertEq(vault.balanceOf(alice), 10 * ONE_GUSD);
        assertEq(vault.availableBalanceOf(alice), 10 * ONE_GUSD);
        assertEq(gusd.balanceOf(address(vault)), 10 * ONE_GUSD);
        assertEq(gusd.balanceOf(alice), 990 * ONE_GUSD);
    }

    function test_DepositRevertsForZeroAmount() public {
        vm.expectRevert(CardVault.ZeroAmount.selector);
        vm.prank(alice);
        vault.deposit(0);
    }

    function test_WithdrawReturnsTokens() public {
        _deposit(alice, 10 * ONE_GUSD);

        vm.expectEmit(true, true, true, true, address(vault));
        emit Withdrawn(alice, bob, 4 * ONE_GUSD);
        vm.prank(alice);
        vault.withdraw(4 * ONE_GUSD, bob);

        assertEq(vault.balanceOf(alice), 6 * ONE_GUSD);
        assertEq(gusd.balanceOf(bob), 1_004 * ONE_GUSD);
        assertEq(gusd.balanceOf(address(vault)), 6 * ONE_GUSD);
    }

    function test_WithdrawCannotDipIntoEscrow() public {
        _deposit(alice, 10 * ONE_GUSD);
        _registerSessionKey(alice, agent, 10 * ONE_GUSD, 100 * ONE_GUSD, 1 days, merchant);

        vm.prank(agent);
        vault.mintCard(alice, 8 * ONE_GUSD, merchant, uint64(block.timestamp + 1 hours));

        vm.expectRevert(
            abi.encodeWithSelector(CardVault.InsufficientAvailableBalance.selector, 2 * ONE_GUSD, 3 * ONE_GUSD)
        );
        vm.prank(alice);
        vault.withdraw(3 * ONE_GUSD, alice);

        // Exactly the available slice still leaves.
        vm.prank(alice);
        vault.withdraw(2 * ONE_GUSD, alice);

        assertEq(vault.balanceOf(alice), 8 * ONE_GUSD);
        assertEq(vault.availableBalanceOf(alice), 0);
        assertEq(gusd.balanceOf(address(vault)), 8 * ONE_GUSD);
    }

    function test_WithdrawRevertsForZeroArguments() public {
        _deposit(alice, 10 * ONE_GUSD);

        vm.expectRevert(CardVault.ZeroAmount.selector);
        vm.prank(alice);
        vault.withdraw(0, alice);

        vm.expectRevert(CardVault.ZeroAddress.selector);
        vm.prank(alice);
        vault.withdraw(ONE_GUSD, address(0));
    }

    /*//////////////////////////////////////////////////////////////
                              SESSION KEYS
    //////////////////////////////////////////////////////////////*/

    function test_RegisterSessionKeyStoresPolicyAndAllowlist() public {
        vm.expectEmit(true, true, true, true, address(vault));
        emit SessionKeyRegistered(alice, agent, 5 * ONE_GUSD, 20 * ONE_GUSD, 1 days);
        vm.expectEmit(true, true, true, true, address(vault));
        emit SessionKeyMerchantSet(alice, agent, merchant, true);
        _registerSessionKey(alice, agent, 5 * ONE_GUSD, 20 * ONE_GUSD, 1 days, merchant);

        SessionPolicy memory policy = vault.sessionPolicy(alice, agent);
        assertEq(policy.capPerCard, 5 * ONE_GUSD);
        assertEq(policy.dailyCap, 20 * ONE_GUSD);
        assertEq(policy.maxExpiry, 1 days);
        assertTrue(policy.active);
        assertTrue(vault.isMerchantAllowed(alice, agent, merchant));
        assertFalse(vault.isMerchantAllowed(alice, agent, otherMerchant));
    }

    function test_RegisterSessionKeyRevertsForZeroKey() public {
        address[] memory merchants = new address[](0);

        vm.expectRevert(CardVault.ZeroAddress.selector);
        vm.prank(alice);
        vault.registerSessionKey(address(0), ONE_GUSD, ONE_GUSD, 1 days, merchants);
    }

    function test_SetSessionKeyMerchantTogglesAllowlist() public {
        _registerSessionKey(alice, agent, 5 * ONE_GUSD, 20 * ONE_GUSD, 1 days, merchant);
        _deposit(alice, 10 * ONE_GUSD);

        vm.expectEmit(true, true, true, true, address(vault));
        emit SessionKeyMerchantSet(alice, agent, merchant, false);
        vm.prank(alice);
        vault.setSessionKeyMerchant(agent, merchant, false);

        assertFalse(vault.isMerchantAllowed(alice, agent, merchant));

        vm.expectRevert(abi.encodeWithSelector(CardVault.MerchantNotAllowed.selector, alice, agent, merchant));
        vm.prank(agent);
        vault.mintCard(alice, ONE_GUSD, merchant, uint64(block.timestamp + 1 hours));
    }

    function test_MintRevertsForUnregisteredSessionKey() public {
        _deposit(alice, 10 * ONE_GUSD);

        vm.expectRevert(abi.encodeWithSelector(CardVault.SessionKeyNotActive.selector, alice, agent));
        vm.prank(agent);
        vault.mintCard(alice, ONE_GUSD, merchant, uint64(block.timestamp + 1 hours));
    }

    function test_RevokedSessionKeyCannotMintButLeavesCardsAlive() public {
        uint256 cardId = _mintInPolicyCard(alice, 5 * ONE_GUSD, merchant);

        vm.expectEmit(true, true, true, true, address(vault));
        emit SessionKeyRevoked(alice, agent);
        vm.prank(alice);
        vault.revokeSessionKey(agent);

        assertFalse(vault.sessionPolicy(alice, agent).active);

        vm.expectRevert(abi.encodeWithSelector(CardVault.SessionKeyNotActive.selector, alice, agent));
        vm.prank(agent);
        vault.mintCard(alice, ONE_GUSD, merchant, uint64(block.timestamp + 1 hours));

        // KTD-3: revocation is not a mass cancellation. The live card still settles.
        assertEq(uint8(vault.getCard(cardId).status), uint8(CardStatus.Active));
        vm.prank(merchant);
        vault.charge(cardId, ONE_GUSD);
        assertEq(gusd.balanceOf(merchant), ONE_GUSD);
    }

    function test_ReRegisterSessionKeyReactivatesWithNewPolicy() public {
        _registerSessionKey(alice, agent, 5 * ONE_GUSD, 20 * ONE_GUSD, 1 days, merchant);
        vm.prank(alice);
        vault.revokeSessionKey(agent);

        _registerSessionKey(alice, agent, ONE_GUSD, 2 * ONE_GUSD, 2 days, merchant);

        SessionPolicy memory policy = vault.sessionPolicy(alice, agent);
        assertTrue(policy.active);
        assertEq(policy.capPerCard, ONE_GUSD);
        assertEq(policy.dailyCap, 2 * ONE_GUSD);
        assertEq(policy.maxExpiry, 2 days);
    }

    /*//////////////////////////////////////////////////////////////
                            IN-POLICY MINTING
    //////////////////////////////////////////////////////////////*/

    function test_MintCardEscrowsAndEmits() public {
        _deposit(alice, 10 * ONE_GUSD);
        _registerSessionKey(alice, agent, 5 * ONE_GUSD, 20 * ONE_GUSD, 1 days, merchant);

        uint64 expiry = uint64(block.timestamp + 1 hours);

        vm.expectEmit(true, true, true, true, address(vault));
        emit CardMinted(1, alice, agent, address(gusd), 5 * ONE_GUSD, merchant, expiry);
        vm.prank(agent);
        uint256 cardId = vault.mintCard(alice, 5 * ONE_GUSD, merchant, expiry);

        assertEq(cardId, 1);
        assertEq(vault.lastCardId(), 1);
        assertEq(vault.mintedOnDay(alice, agent, vault.currentDay()), 5 * ONE_GUSD);

        Card memory card = vault.getCard(cardId);
        assertEq(card.vaultOwner, alice);
        assertEq(card.agent, agent);
        assertEq(card.expiry, expiry);
        assertEq(uint8(card.status), uint8(CardStatus.Active));
    }

    function test_MintRevertsForCapAbovePerCardLimit() public {
        _deposit(alice, 100 * ONE_GUSD);
        _registerSessionKey(alice, agent, 5 * ONE_GUSD, 100 * ONE_GUSD, 1 days, merchant);

        vm.expectRevert(abi.encodeWithSelector(CardVault.CapPerCardExceeded.selector, 6 * ONE_GUSD, 5 * ONE_GUSD));
        vm.prank(agent);
        vault.mintCard(alice, 6 * ONE_GUSD, merchant, uint64(block.timestamp + 1 hours));
    }

    function test_MintRevertsForZeroCap() public {
        _deposit(alice, 10 * ONE_GUSD);
        _registerSessionKey(alice, agent, 5 * ONE_GUSD, 100 * ONE_GUSD, 1 days, merchant);

        vm.expectRevert(CardVault.ZeroAmount.selector);
        vm.prank(agent);
        vault.mintCard(alice, 0, merchant, uint64(block.timestamp + 1 hours));
    }

    function test_MintRevertsForExpiryInPast() public {
        _deposit(alice, 10 * ONE_GUSD);
        _registerSessionKey(alice, agent, 5 * ONE_GUSD, 100 * ONE_GUSD, 1 days, merchant);

        uint64 pastExpiry = uint64(block.timestamp - 1);
        vm.expectRevert(abi.encodeWithSelector(CardVault.ExpiryInPast.selector, pastExpiry));
        vm.prank(agent);
        vault.mintCard(alice, ONE_GUSD, merchant, pastExpiry);

        // `now` is already too late: the card would be dead on arrival.
        uint64 nowExpiry = uint64(block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(CardVault.ExpiryInPast.selector, nowExpiry));
        vm.prank(agent);
        vault.mintCard(alice, ONE_GUSD, merchant, nowExpiry);

        assertEq(vault.escrowedOf(alice), 0);
        assertEq(vault.lastCardId(), 0);
    }

    function test_MintRevertsForExpiryBeyondPolicy() public {
        _deposit(alice, 10 * ONE_GUSD);
        _registerSessionKey(alice, agent, 5 * ONE_GUSD, 100 * ONE_GUSD, 1 hours, merchant);

        uint64 latestAllowed = uint64(block.timestamp + 1 hours);
        uint64 tooFar = latestAllowed + 1;

        vm.expectRevert(abi.encodeWithSelector(CardVault.ExpiryTooFar.selector, tooFar, latestAllowed));
        vm.prank(agent);
        vault.mintCard(alice, ONE_GUSD, merchant, tooFar);

        // The boundary itself is allowed.
        vm.prank(agent);
        vault.mintCard(alice, ONE_GUSD, merchant, latestAllowed);
    }

    function test_MintRevertsForZeroMerchantScopeOnSessionPath() public {
        _deposit(alice, 10 * ONE_GUSD);
        _registerSessionKey(alice, agent, 5 * ONE_GUSD, 100 * ONE_GUSD, 1 days, merchant);

        vm.expectRevert(abi.encodeWithSelector(CardVault.MerchantNotAllowed.selector, alice, agent, address(0)));
        vm.prank(agent);
        vault.mintCard(alice, ONE_GUSD, address(0), uint64(block.timestamp + 1 hours));
    }

    function test_DailyCapBlocksNthMintAndResetsNextDay() public {
        _deposit(alice, 100 * ONE_GUSD);
        _registerSessionKey(alice, agent, 6 * ONE_GUSD, 10 * ONE_GUSD, 30 days, merchant);

        uint256 dayOne = vault.currentDay();

        vm.prank(agent);
        vault.mintCard(alice, 6 * ONE_GUSD, merchant, uint64(block.timestamp + 1 hours));
        assertEq(vault.mintedOnDay(alice, agent, dayOne), 6 * ONE_GUSD);

        vm.expectRevert(abi.encodeWithSelector(CardVault.DailyCapExceeded.selector, 12 * ONE_GUSD, 10 * ONE_GUSD));
        vm.prank(agent);
        vault.mintCard(alice, 6 * ONE_GUSD, merchant, uint64(block.timestamp + 1 hours));

        // Same day, a smaller card that still fits under the cap goes through.
        vm.prank(agent);
        vault.mintCard(alice, 4 * ONE_GUSD, merchant, uint64(block.timestamp + 1 hours));
        assertEq(vault.mintedOnDay(alice, agent, dayOne), 10 * ONE_GUSD);

        // Roll into the next UTC day: the window is fresh.
        vm.warp((dayOne + 1) * 1 days + 1);
        assertEq(vault.currentDay(), dayOne + 1);

        vm.prank(agent);
        vault.mintCard(alice, 6 * ONE_GUSD, merchant, uint64(block.timestamp + 1 hours));

        assertEq(vault.mintedOnDay(alice, agent, dayOne), 10 * ONE_GUSD);
        assertEq(vault.mintedOnDay(alice, agent, dayOne + 1), 6 * ONE_GUSD);
    }

    function test_DailyCapIsNotRefundedByCancellation() public {
        _deposit(alice, 100 * ONE_GUSD);
        _registerSessionKey(alice, agent, 6 * ONE_GUSD, 10 * ONE_GUSD, 1 days, merchant);

        vm.prank(agent);
        uint256 cardId = vault.mintCard(alice, 6 * ONE_GUSD, merchant, uint64(block.timestamp + 1 hours));

        vm.prank(alice);
        vault.cancelCard(cardId);

        // Escrow came back, but the day's allowance did not.
        assertEq(vault.availableBalanceOf(alice), 100 * ONE_GUSD);
        vm.expectRevert(abi.encodeWithSelector(CardVault.DailyCapExceeded.selector, 12 * ONE_GUSD, 10 * ONE_GUSD));
        vm.prank(agent);
        vault.mintCard(alice, 6 * ONE_GUSD, merchant, uint64(block.timestamp + 1 hours));
    }

    /*//////////////////////////////////////////////////////////////
                         OWNER-SIGNED MINTING
    //////////////////////////////////////////////////////////////*/

    function test_ApprovalMintConsumesApprovalId() public {
        _deposit(alice, 10 * ONE_GUSD);

        CardApproval memory approval =
            _approval(alice, agent, 5 * ONE_GUSD, merchant, uint64(block.timestamp + 1 hours), "a1");
        assertFalse(vault.isApprovalUsed(alice, "a1"));

        vm.expectEmit(true, true, true, true, address(vault));
        emit ApprovalConsumed(alice, "a1", 1);
        vm.prank(relayer);
        vault.mintCardWithApproval(approval, _sign(alicePk, approval));

        assertTrue(vault.isApprovalUsed(alice, "a1"));
    }

    function test_ApprovalRevertsOnReplayedApprovalId() public {
        _deposit(alice, 100 * ONE_GUSD);

        CardApproval memory approval =
            _approval(alice, agent, 5 * ONE_GUSD, merchant, uint64(block.timestamp + 1 hours), "a1");
        bytes memory signature = _sign(alicePk, approval);

        vm.prank(relayer);
        vault.mintCardWithApproval(approval, signature);

        vm.expectRevert(abi.encodeWithSelector(CardVault.ApprovalAlreadyUsed.selector, alice, bytes32("a1")));
        vm.prank(relayer);
        vault.mintCardWithApproval(approval, signature);

        // Only the id is burned; the very same terms re-sign fine under a fresh id.
        CardApproval memory second =
            _approval(alice, agent, 5 * ONE_GUSD, merchant, uint64(block.timestamp + 1 hours), "a2");
        vm.prank(relayer);
        vault.mintCardWithApproval(second, _sign(alicePk, second));
        assertEq(vault.escrowedOf(alice), 10 * ONE_GUSD);
    }

    function test_ApprovalRevertsForWrongSigner() public {
        _deposit(alice, 10 * ONE_GUSD);

        CardApproval memory approval =
            _approval(alice, agent, 5 * ONE_GUSD, merchant, uint64(block.timestamp + 1 hours), "a1");
        bytes memory wrongSignature = _sign(bobPk, approval);

        vm.expectRevert(CardVault.InvalidSignature.selector);
        vm.prank(relayer);
        vault.mintCardWithApproval(approval, wrongSignature);
    }

    function test_ApprovalRevertsForTamperedField() public {
        _deposit(alice, 100 * ONE_GUSD);

        CardApproval memory approval =
            _approval(alice, agent, 5 * ONE_GUSD, merchant, uint64(block.timestamp + 1 hours), "a1");
        bytes memory signature = _sign(alicePk, approval);

        approval.cap = 50 * ONE_GUSD;
        vm.expectRevert(CardVault.InvalidSignature.selector);
        vm.prank(relayer);
        vault.mintCardWithApproval(approval, signature);
    }

    function test_ApprovalRevertsForUnsupportedToken() public {
        _deposit(alice, 10 * ONE_GUSD);

        CardApproval memory approval =
            _approval(alice, agent, 5 * ONE_GUSD, merchant, uint64(block.timestamp + 1 hours), "a1");
        approval.token = address(0xBEEF);
        bytes memory signature = _sign(alicePk, approval);

        vm.expectRevert(abi.encodeWithSelector(CardVault.UnsupportedToken.selector, address(0xBEEF)));
        vm.prank(relayer);
        vault.mintCardWithApproval(approval, signature);
    }

    function test_ApprovalRevertsForExpiryInPastAndOverdraft() public {
        _deposit(alice, 4 * ONE_GUSD);

        CardApproval memory expired = _approval(alice, agent, ONE_GUSD, merchant, uint64(block.timestamp - 1), "past");
        bytes memory expiredSignature = _sign(alicePk, expired);

        vm.expectRevert(abi.encodeWithSelector(CardVault.ExpiryInPast.selector, uint64(block.timestamp - 1)));
        vm.prank(relayer);
        vault.mintCardWithApproval(expired, expiredSignature);

        CardApproval memory tooBig =
            _approval(alice, agent, 5 * ONE_GUSD, merchant, uint64(block.timestamp + 1 hours), "big");
        bytes memory tooBigSignature = _sign(alicePk, tooBig);

        vm.expectRevert(
            abi.encodeWithSelector(CardVault.InsufficientAvailableBalance.selector, 4 * ONE_GUSD, 5 * ONE_GUSD)
        );
        vm.prank(relayer);
        vault.mintCardWithApproval(tooBig, tooBigSignature);
    }

    function test_ApprovalWithOpenScopeIsChargeableByAnyone() public {
        _deposit(alice, 10 * ONE_GUSD);

        CardApproval memory approval =
            _approval(alice, agent, 5 * ONE_GUSD, address(0), uint64(block.timestamp + 1 hours), "open");

        vm.prank(relayer);
        uint256 cardId = vault.mintCardWithApproval(approval, _sign(alicePk, approval));

        vm.prank(otherMerchant);
        vault.charge(cardId, 2 * ONE_GUSD);
        assertEq(gusd.balanceOf(otherMerchant), 2 * ONE_GUSD);
    }

    function test_ApprovalDigestBindsChainIdAndVaultAddress() public {
        CardApproval memory approval =
            _approval(alice, agent, 5 * ONE_GUSD, merchant, uint64(block.timestamp + 1 hours), "a1");

        bytes32 digest = vault.hashCardApproval(approval);

        CardVault otherVault = CardVault(
            Upgrades.deployUUPSProxy(
                "CardVault.sol:CardVault", abi.encodeCall(CardVault.initialize, (admin, address(gusd)))
            )
        );
        assertNotEq(otherVault.hashCardApproval(approval), digest);

        vm.chainId(block.chainid + 1);
        assertNotEq(vault.hashCardApproval(approval), digest);
    }

    function test_ApprovalIdIsScopedToItsSigner() public {
        _deposit(alice, 10 * ONE_GUSD);
        _deposit(bob, 10 * ONE_GUSD);

        CardApproval memory aliceApproval =
            _approval(alice, agent, 5 * ONE_GUSD, merchant, uint64(block.timestamp + 1 hours), "shared");
        vm.prank(relayer);
        vault.mintCardWithApproval(aliceApproval, _sign(alicePk, aliceApproval));

        // Bob's identical approval id is a different slot entirely.
        assertFalse(vault.isApprovalUsed(bob, "shared"));
        CardApproval memory bobApproval =
            _approval(bob, agent, 5 * ONE_GUSD, merchant, uint64(block.timestamp + 1 hours), "shared");
        vm.prank(relayer);
        vault.mintCardWithApproval(bobApproval, _sign(bobPk, bobApproval));

        assertEq(vault.escrowedOf(alice), 5 * ONE_GUSD);
        assertEq(vault.escrowedOf(bob), 5 * ONE_GUSD);
    }

    /*//////////////////////////////////////////////////////////////
                                CHARGE
    //////////////////////////////////////////////////////////////*/

    function test_ChargeRevertsForOutOfScopeCaller() public {
        uint256 cardId = _mintInPolicyCard(alice, 5 * ONE_GUSD, merchant);

        vm.expectRevert(
            abi.encodeWithSelector(CardVault.MerchantScopeMismatch.selector, cardId, otherMerchant, merchant)
        );
        vm.prank(otherMerchant);
        vault.charge(cardId, ONE_GUSD);

        // Not even the vault owner may pull funds through a scoped card.
        vm.expectRevert(abi.encodeWithSelector(CardVault.MerchantScopeMismatch.selector, cardId, alice, merchant));
        vm.prank(alice);
        vault.charge(cardId, ONE_GUSD);

        assertEq(uint8(vault.getCard(cardId).status), uint8(CardStatus.Active));
    }

    function test_ChargeRevertsAboveCapAndForZero() public {
        uint256 cardId = _mintInPolicyCard(alice, 5 * ONE_GUSD, merchant);

        vm.expectRevert(abi.encodeWithSelector(CardVault.ChargeExceedsCap.selector, 5 * ONE_GUSD + 1, 5 * ONE_GUSD));
        vm.prank(merchant);
        vault.charge(cardId, 5 * ONE_GUSD + 1);

        vm.expectRevert(CardVault.ZeroAmount.selector);
        vm.prank(merchant);
        vault.charge(cardId, 0);

        // The full cap is chargeable and releases nothing.
        vm.prank(merchant);
        vault.charge(cardId, 5 * ONE_GUSD);
        assertEq(vault.balanceOf(alice), 5 * ONE_GUSD);
        assertEq(vault.escrowedOf(alice), 0);
    }

    function test_ChargeRevertsForUnknownCard() public {
        vm.expectRevert(abi.encodeWithSelector(CardVault.CardNotActive.selector, uint256(42), CardStatus.None));
        vm.prank(merchant);
        vault.charge(42, ONE_GUSD);
    }

    function test_CancelThenChargeReverts() public {
        uint256 cardId = _mintInPolicyCard(alice, 5 * ONE_GUSD, merchant);

        vm.expectEmit(true, true, true, true, address(vault));
        emit CardCancelled(cardId, alice, 5 * ONE_GUSD);
        vm.prank(alice);
        vault.cancelCard(cardId);

        assertEq(vault.escrowedOf(alice), 0);
        assertEq(vault.availableBalanceOf(alice), 10 * ONE_GUSD);

        vm.expectRevert(abi.encodeWithSelector(CardVault.CardNotActive.selector, cardId, CardStatus.Revoked));
        vm.prank(merchant);
        vault.charge(cardId, ONE_GUSD);
    }

    function test_CancelRevertsForNonOwnerAndForDeadCards() public {
        uint256 cardId = _mintInPolicyCard(alice, 5 * ONE_GUSD, merchant);

        vm.expectRevert(abi.encodeWithSelector(CardVault.NotCardOwner.selector, cardId, bob, alice));
        vm.prank(bob);
        vault.cancelCard(cardId);

        // The agent that minted it has no cancellation rights either.
        vm.expectRevert(abi.encodeWithSelector(CardVault.NotCardOwner.selector, cardId, agent, alice));
        vm.prank(agent);
        vault.cancelCard(cardId);

        vm.prank(alice);
        vault.cancelCard(cardId);

        vm.expectRevert(abi.encodeWithSelector(CardVault.CardNotActive.selector, cardId, CardStatus.Revoked));
        vm.prank(alice);
        vault.cancelCard(cardId);
    }

    /*//////////////////////////////////////////////////////////////
                                EXPIRY
    //////////////////////////////////////////////////////////////*/

    function test_ReleaseExpiredRevertsWhileCardIsLive() public {
        uint256 cardId = _mintInPolicyCard(alice, 5 * ONE_GUSD, merchant);
        uint64 expiry = vault.getCard(cardId).expiry;

        vm.expectRevert(abi.encodeWithSelector(CardVault.CardNotExpired.selector, cardId, expiry));
        vault.releaseExpired(cardId);

        // Exactly at the expiry timestamp the card is still alive.
        vm.warp(expiry);
        vm.expectRevert(abi.encodeWithSelector(CardVault.CardNotExpired.selector, cardId, expiry));
        vault.releaseExpired(cardId);

        assertEq(vault.escrowedOf(alice), 5 * ONE_GUSD);
    }

    function test_ReleaseExpiredIsPermissionlessAndReturnsEscrow() public {
        uint256 cardId = _mintInPolicyCard(alice, 5 * ONE_GUSD, merchant);
        uint64 expiry = vault.getCard(cardId).expiry;

        vm.warp(uint256(expiry) + 1);

        vm.expectEmit(true, true, true, true, address(vault));
        emit CardExpiredReleased(cardId, alice, relayer, 5 * ONE_GUSD);
        vm.prank(relayer);
        vault.releaseExpired(cardId);

        assertEq(uint8(vault.getCard(cardId).status), uint8(CardStatus.Expired));
        assertEq(vault.escrowedOf(alice), 0);
        assertEq(vault.availableBalanceOf(alice), 10 * ONE_GUSD);
        assertEq(vault.balanceOf(alice), 10 * ONE_GUSD);

        // Reaping is idempotent by refusal, so the accumulator cannot be drained twice.
        vm.expectRevert(abi.encodeWithSelector(CardVault.CardNotActive.selector, cardId, CardStatus.Expired));
        vault.releaseExpired(cardId);
    }

    function test_ChargeRevertsAfterExpiryEvenBeforeReaping() public {
        uint256 cardId = _mintInPolicyCard(alice, 5 * ONE_GUSD, merchant);
        uint64 expiry = vault.getCard(cardId).expiry;

        // One second past the last chargeable moment, with the escrow still locked.
        vm.warp(uint256(expiry) + 1);

        vm.expectRevert(abi.encodeWithSelector(CardVault.CardExpired.selector, cardId, expiry));
        vm.prank(merchant);
        vault.charge(cardId, ONE_GUSD);

        assertEq(uint8(vault.getCard(cardId).status), uint8(CardStatus.Active));
        assertEq(vault.escrowedOf(alice), 5 * ONE_GUSD);
    }

    function test_ChargeSucceedsExactlyAtExpiry() public {
        uint256 cardId = _mintInPolicyCard(alice, 5 * ONE_GUSD, merchant);

        vm.warp(vault.getCard(cardId).expiry);
        vm.prank(merchant);
        vault.charge(cardId, ONE_GUSD);

        assertEq(uint8(vault.getCard(cardId).status), uint8(CardStatus.Used));
    }

    function test_ReleaseExpiredRevertsForChargedCard() public {
        uint256 cardId = _mintInPolicyCard(alice, 5 * ONE_GUSD, merchant);

        vm.prank(merchant);
        vault.charge(cardId, ONE_GUSD);

        vm.warp(uint256(vault.getCard(cardId).expiry) + 1);
        vm.expectRevert(abi.encodeWithSelector(CardVault.CardNotActive.selector, cardId, CardStatus.Used));
        vault.releaseExpired(cardId);
    }

    /*//////////////////////////////////////////////////////////////
                            OWNER ISOLATION
    //////////////////////////////////////////////////////////////*/

    function test_OwnerIsolation() public {
        _deposit(alice, 10 * ONE_GUSD);
        _deposit(bob, 10 * ONE_GUSD);
        _registerSessionKey(alice, agent, 5 * ONE_GUSD, 100 * ONE_GUSD, 1 days, merchant);

        vm.prank(agent);
        uint256 aliceCard = vault.mintCard(alice, 5 * ONE_GUSD, merchant, uint64(block.timestamp + 1 hours));

        // Alice's session key is meaningless in Bob's namespace.
        assertFalse(vault.sessionPolicy(bob, agent).active);
        assertFalse(vault.isMerchantAllowed(bob, agent, merchant));
        vm.expectRevert(abi.encodeWithSelector(CardVault.SessionKeyNotActive.selector, bob, agent));
        vm.prank(agent);
        vault.mintCard(bob, ONE_GUSD, merchant, uint64(block.timestamp + 1 hours));

        // Bob cannot cancel Alice's card...
        vm.expectRevert(abi.encodeWithSelector(CardVault.NotCardOwner.selector, aliceCard, bob, alice));
        vm.prank(bob);
        vault.cancelCard(aliceCard);

        // ...nor revoke her key: revocation only ever writes his own namespace.
        vm.prank(bob);
        vault.revokeSessionKey(agent);
        assertTrue(vault.sessionPolicy(alice, agent).active);

        // ...nor withdraw against her balance.
        vm.expectRevert(
            abi.encodeWithSelector(CardVault.InsufficientAvailableBalance.selector, 10 * ONE_GUSD, 11 * ONE_GUSD)
        );
        vm.prank(bob);
        vault.withdraw(11 * ONE_GUSD, bob);

        // ...nor sign an approval that spends her funds.
        CardApproval memory forged =
            _approval(alice, agent, 5 * ONE_GUSD, merchant, uint64(block.timestamp + 1 hours), "forged");
        bytes memory forgedSignature = _sign(bobPk, forged);

        vm.expectRevert(CardVault.InvalidSignature.selector);
        vm.prank(bob);
        vault.mintCardWithApproval(forged, forgedSignature);

        // Alice charging through and Bob withdrawing leave the other's books untouched.
        vm.prank(merchant);
        vault.charge(aliceCard, 2 * ONE_GUSD);
        vm.prank(bob);
        vault.withdraw(10 * ONE_GUSD, bob);

        assertEq(vault.balanceOf(alice), 8 * ONE_GUSD);
        assertEq(vault.escrowedOf(alice), 0);
        assertEq(vault.balanceOf(bob), 0);
        assertEq(vault.escrowedOf(bob), 0);
        assertEq(gusd.balanceOf(address(vault)), 8 * ONE_GUSD);
    }

    function test_AdminHasNoPowerOverVaultOwnerFunds() public {
        uint256 cardId = _mintInPolicyCard(alice, 5 * ONE_GUSD, merchant);

        vm.expectRevert(abi.encodeWithSelector(CardVault.NotCardOwner.selector, cardId, admin, alice));
        vm.prank(admin);
        vault.cancelCard(cardId);

        vm.expectRevert(abi.encodeWithSelector(CardVault.InsufficientAvailableBalance.selector, 0, ONE_GUSD));
        vm.prank(admin);
        vault.withdraw(ONE_GUSD, admin);
    }

    /*//////////////////////////////////////////////////////////////
                                 FUZZ
    //////////////////////////////////////////////////////////////*/

    function testFuzz_ChargeRespectsCapAndConservesFunds(uint256 cap, uint256 amount) public {
        cap = bound(cap, 1, 100 * ONE_GUSD);
        amount = bound(amount, 0, cap + 10 * ONE_GUSD);

        _deposit(alice, 100 * ONE_GUSD);
        _registerSessionKey(alice, agent, 100 * ONE_GUSD, 1_000 * ONE_GUSD, 1 days, merchant);

        vm.prank(agent);
        uint256 cardId = vault.mintCard(alice, cap, merchant, uint64(block.timestamp + 1 hours));
        assertEq(vault.availableBalanceOf(alice), 100 * ONE_GUSD - cap);

        if (amount == 0) {
            vm.expectRevert(CardVault.ZeroAmount.selector);
            vm.prank(merchant);
            vault.charge(cardId, amount);
            return;
        }

        if (amount > cap) {
            vm.expectRevert(abi.encodeWithSelector(CardVault.ChargeExceedsCap.selector, amount, cap));
            vm.prank(merchant);
            vault.charge(cardId, amount);

            assertEq(vault.escrowedOf(alice), cap);
            return;
        }

        vm.prank(merchant);
        vault.charge(cardId, amount);

        assertEq(gusd.balanceOf(merchant), amount);
        assertEq(vault.balanceOf(alice), 100 * ONE_GUSD - amount);
        assertEq(vault.escrowedOf(alice), 0);
        assertEq(vault.availableBalanceOf(alice), 100 * ONE_GUSD - amount);
        // The vault never holds less than it owes its one depositor.
        assertEq(gusd.balanceOf(address(vault)), vault.balanceOf(alice));
        assertEq(uint8(vault.getCard(cardId).status), uint8(CardStatus.Used));
    }

    /*//////////////////////////////////////////////////////////////
                                UPGRADES
    //////////////////////////////////////////////////////////////*/

    function test_UpgradeToV2PreservesStorage() public {
        // Seed every storage family: balance, escrow, a card, a policy and a used approval id.
        _deposit(alice, 20 * ONE_GUSD);
        _registerSessionKey(alice, agent, 5 * ONE_GUSD, 100 * ONE_GUSD, 1 days, merchant);

        uint64 expiry = uint64(block.timestamp + 1 hours);
        vm.prank(agent);
        uint256 cardId = vault.mintCard(alice, 5 * ONE_GUSD, merchant, expiry);

        CardApproval memory approval = _approval(alice, agent, 3 * ONE_GUSD, otherMerchant, expiry, "u1");
        vm.prank(relayer);
        uint256 signedCardId = vault.mintCardWithApproval(approval, _sign(alicePk, approval));

        address implementationBefore = Upgrades.getImplementationAddress(address(vault));

        Upgrades.upgradeProxy(
            address(vault), "CardVault.t.sol:CardVaultV2", abi.encodeCall(CardVaultV2.initializeV2, (250)), admin
        );

        CardVaultV2 upgraded = CardVaultV2(address(vault));

        assertEq(upgraded.version(), "2");
        assertNotEq(Upgrades.getImplementationAddress(address(vault)), implementationBefore);
        assertEq(upgraded.protocolFeeBps(), 250);

        // Admin, token and counters survive.
        assertEq(upgraded.owner(), admin);
        assertEq(upgraded.paymentToken(), address(gusd));
        assertEq(upgraded.lastCardId(), 2);

        // Books survive.
        assertEq(upgraded.balanceOf(alice), 20 * ONE_GUSD);
        assertEq(upgraded.escrowedOf(alice), 8 * ONE_GUSD);
        assertEq(upgraded.availableBalanceOf(alice), 12 * ONE_GUSD);

        // Cards survive, field for field.
        Card memory card = upgraded.getCard(cardId);
        assertEq(card.vaultOwner, alice);
        assertEq(card.agent, agent);
        assertEq(card.cap, 5 * ONE_GUSD);
        assertEq(card.merchantScope, merchant);
        assertEq(card.expiry, expiry);
        assertEq(uint8(card.status), uint8(CardStatus.Active));
        assertEq(uint8(upgraded.getCard(signedCardId).status), uint8(CardStatus.Active));

        // Policies, day counters and consumed approval ids survive.
        SessionPolicy memory policy = upgraded.sessionPolicy(alice, agent);
        assertEq(policy.capPerCard, 5 * ONE_GUSD);
        assertEq(policy.dailyCap, 100 * ONE_GUSD);
        assertTrue(policy.active);
        assertTrue(upgraded.isMerchantAllowed(alice, agent, merchant));
        assertEq(upgraded.mintedOnDay(alice, agent, upgraded.currentDay()), 5 * ONE_GUSD);
        assertTrue(upgraded.isApprovalUsed(alice, "u1"));

        // The pre-upgrade card still settles under the new implementation.
        vm.prank(merchant);
        upgraded.charge(cardId, 2 * ONE_GUSD);
        assertEq(upgraded.balanceOf(alice), 18 * ONE_GUSD);
        assertEq(upgraded.escrowedOf(alice), 3 * ONE_GUSD);

        vm.expectRevert(Initializable.InvalidInitialization.selector);
        upgraded.initializeV2(1);
    }

    function test_UpgradeRevertsForNonAdmin() public {
        address newImplementation = address(new CardVaultV2());

        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        UUPSUpgradeable(address(vault)).upgradeToAndCall(newImplementation, "");
    }

    function test_UpgradeSucceedsForAdmin() public {
        address newImplementation = address(new CardVaultV2());

        vm.prank(admin);
        UUPSUpgradeable(address(vault)).upgradeToAndCall(newImplementation, "");

        assertEq(Upgrades.getImplementationAddress(address(vault)), newImplementation);
        assertEq(CardVaultV2(address(vault)).version(), "2");
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _deposit(address vaultOwner, uint256 amount) internal {
        vm.prank(vaultOwner);
        vault.deposit(amount);
    }

    function _registerSessionKey(
        address vaultOwner,
        address sessionKey,
        uint256 capPerCard,
        uint256 dailyCap,
        uint64 maxExpiry,
        address allowedMerchant
    ) internal {
        address[] memory merchants = new address[](1);
        merchants[0] = allowedMerchant;

        vm.prank(vaultOwner);
        vault.registerSessionKey(sessionKey, capPerCard, dailyCap, maxExpiry, merchants);
    }

    /// @dev Deposits 10 gUSD, registers `agent` and mints one in-policy card of `cap`.
    function _mintInPolicyCard(address vaultOwner, uint256 cap, address scope) internal returns (uint256 cardId) {
        _deposit(vaultOwner, 10 * ONE_GUSD);
        _registerSessionKey(vaultOwner, agent, cap, 100 * ONE_GUSD, 1 days, scope);

        vm.prank(agent);
        cardId = vault.mintCard(vaultOwner, cap, scope, uint64(block.timestamp + 1 hours));
    }

    function _approval(
        address vaultOwner,
        address cardAgent,
        uint256 cap,
        address merchantScope,
        uint64 expiry,
        bytes32 approvalId
    ) internal view returns (CardApproval memory) {
        return CardApproval({
            vaultOwner: vaultOwner,
            agent: cardAgent,
            token: address(gusd),
            cap: cap,
            merchantScope: merchantScope,
            expiry: expiry,
            approvalId: approvalId
        });
    }

    function _sign(uint256 privateKey, CardApproval memory approval) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, vault.hashCardApproval(approval));
        return abi.encodePacked(r, s, v);
    }
}
