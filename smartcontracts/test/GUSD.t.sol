// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Upgrades} from "openzeppelin-foundry-upgrades/Upgrades.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {GUSD} from "../src/GUSD.sol";

/**
 * @dev Test-only V2 of {GUSD}. Appends state after the inherited layout and adds behaviour,
 * so the upgrade test can prove both that old storage survives and that new storage works.
 * @custom:oz-upgrades-from GUSD
 */
contract GUSDV2 is GUSD {
    /// @notice New state appended by V2, after the inherited `__gap`.
    uint256 public faucetBonus;

    /// @notice Initializes the V2-only state during the upgrade call.
    /// @dev Parent initializers are deliberately not re-run: the proxy was already initialized by V1.
    /// @custom:oz-upgrades-validate-as-initializer
    /// @custom:oz-upgrades-unsafe-allow missing-initializer-call
    function initializeV2(uint256 bonus) external reinitializer(2) {
        faucetBonus = bonus;
    }

    /// @notice Sets the V2-only bonus value.
    function setFaucetBonus(uint256 bonus) external onlyOwner {
        faucetBonus = bonus;
    }

    /// @notice Marker used to assert that the proxy now runs V2 code.
    function version() external pure returns (string memory) {
        return "2";
    }
}

contract GUSDTest is Test {
    GUSD internal gusd;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal constant ONE_GUSD = 1e6;
    uint256 internal constant EXPECTED_FAUCET_AMOUNT = 100e6;

    event FaucetClaimed(address indexed account, uint256 amount);

    function setUp() public {
        // Start from a realistic timestamp so cooldown arithmetic is not pinned to genesis.
        vm.warp(1_750_000_000);

        address proxy = Upgrades.deployUUPSProxy("GUSD.sol:GUSD", abi.encodeCall(GUSD.initialize, (owner)));
        gusd = GUSD(proxy);
    }

    /*//////////////////////////////////////////////////////////////
                                METADATA
    //////////////////////////////////////////////////////////////*/

    function test_Metadata() public view {
        assertEq(gusd.name(), "GiwaCard USD");
        assertEq(gusd.symbol(), "gUSD");
        assertEq(gusd.decimals(), 6);
        assertEq(gusd.totalSupply(), 0);
        assertEq(gusd.owner(), owner);
    }

    function test_DecimalsIsSix() public view {
        assertEq(gusd.decimals(), 6);
    }

    function test_FaucetConstants() public view {
        assertEq(gusd.FAUCET_AMOUNT(), EXPECTED_FAUCET_AMOUNT);
        assertEq(gusd.FAUCET_AMOUNT(), 100 * 10 ** gusd.decimals());
        assertEq(gusd.FAUCET_COOLDOWN(), 24 hours);
    }

    /*//////////////////////////////////////////////////////////////
                             INITIALIZATION
    //////////////////////////////////////////////////////////////*/

    function test_InitializeRevertsWhenCalledTwice() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        gusd.initialize(alice);
    }

    function test_InitializeRevertsOnImplementation() public {
        address implementation = Upgrades.getImplementationAddress(address(gusd));

        vm.expectRevert(Initializable.InvalidInitialization.selector);
        GUSD(implementation).initialize(alice);
    }

    function test_InitializeRevertsForZeroOwner() public {
        address implementation = Upgrades.getImplementationAddress(address(gusd));

        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableInvalidOwner.selector, address(0)));
        new ERC1967Proxy(implementation, abi.encodeCall(GUSD.initialize, (address(0))));
    }

    /*//////////////////////////////////////////////////////////////
                                 FAUCET
    //////////////////////////////////////////////////////////////*/

    function test_ClaimFaucetMintsExactlyOneHundred() public {
        vm.prank(alice);
        gusd.claimFaucet();

        assertEq(gusd.balanceOf(alice), EXPECTED_FAUCET_AMOUNT);
        assertEq(gusd.balanceOf(alice), 100 * 10 ** gusd.decimals());
        assertEq(gusd.totalSupply(), EXPECTED_FAUCET_AMOUNT);
        assertEq(gusd.lastFaucetClaim(alice), block.timestamp);
        assertEq(gusd.faucetAvailableAt(alice), block.timestamp + 24 hours);
    }

    function test_ClaimFaucetEmitsEvent() public {
        vm.expectEmit(true, true, true, true, address(gusd));
        emit FaucetClaimed(alice, EXPECTED_FAUCET_AMOUNT);

        vm.prank(alice);
        gusd.claimFaucet();
    }

    function test_FaucetAvailableAtIsZeroBeforeFirstClaim() public view {
        assertEq(gusd.lastFaucetClaim(alice), 0);
        assertEq(gusd.faucetAvailableAt(alice), 0);
    }

    function test_ClaimFaucetRevertsWithinCooldown() public {
        vm.prank(alice);
        gusd.claimFaucet();

        uint256 availableAt = block.timestamp + 24 hours;

        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(abi.encodeWithSelector(GUSD.FaucetCooldownActive.selector, availableAt));
        vm.prank(alice);
        gusd.claimFaucet();

        assertEq(gusd.balanceOf(alice), EXPECTED_FAUCET_AMOUNT);
    }

    function test_ClaimFaucetRevertsImmediatelyAfterClaim() public {
        vm.prank(alice);
        gusd.claimFaucet();

        vm.expectRevert(abi.encodeWithSelector(GUSD.FaucetCooldownActive.selector, block.timestamp + 24 hours));
        vm.prank(alice);
        gusd.claimFaucet();
    }

    function test_ClaimFaucetRevertsOneSecondBeforeCooldownElapses() public {
        vm.prank(alice);
        gusd.claimFaucet();

        uint256 availableAt = block.timestamp + 24 hours;

        vm.warp(availableAt - 1);
        vm.expectRevert(abi.encodeWithSelector(GUSD.FaucetCooldownActive.selector, availableAt));
        vm.prank(alice);
        gusd.claimFaucet();
    }

    function test_ClaimFaucetSucceedsExactlyAtCooldownBoundary() public {
        vm.prank(alice);
        gusd.claimFaucet();

        vm.warp(block.timestamp + 24 hours);
        vm.prank(alice);
        gusd.claimFaucet();

        assertEq(gusd.balanceOf(alice), 2 * EXPECTED_FAUCET_AMOUNT);
        assertEq(gusd.lastFaucetClaim(alice), block.timestamp);
    }

    function test_ClaimFaucetSucceedsAfterCooldown() public {
        vm.prank(alice);
        gusd.claimFaucet();

        vm.warp(block.timestamp + 25 hours);
        vm.prank(alice);
        gusd.claimFaucet();

        assertEq(gusd.balanceOf(alice), 2 * EXPECTED_FAUCET_AMOUNT);
        assertEq(gusd.totalSupply(), 2 * EXPECTED_FAUCET_AMOUNT);
    }

    function test_FaucetCooldownIsPerAddress() public {
        vm.prank(alice);
        gusd.claimFaucet();

        // Bob has never claimed, so Alice's cooldown must not block him.
        vm.prank(bob);
        gusd.claimFaucet();

        assertEq(gusd.balanceOf(alice), EXPECTED_FAUCET_AMOUNT);
        assertEq(gusd.balanceOf(bob), EXPECTED_FAUCET_AMOUNT);
        assertEq(gusd.totalSupply(), 2 * EXPECTED_FAUCET_AMOUNT);

        vm.expectRevert(abi.encodeWithSelector(GUSD.FaucetCooldownActive.selector, gusd.faucetAvailableAt(bob)));
        vm.prank(bob);
        gusd.claimFaucet();
    }

    function testFuzz_ClaimFaucetRespectsCooldown(uint256 elapsed) public {
        elapsed = bound(elapsed, 0, 365 days);

        vm.prank(alice);
        gusd.claimFaucet();
        uint256 availableAt = gusd.faucetAvailableAt(alice);

        vm.warp(block.timestamp + elapsed);
        if (elapsed < 24 hours) {
            vm.expectRevert(abi.encodeWithSelector(GUSD.FaucetCooldownActive.selector, availableAt));
            vm.prank(alice);
            gusd.claimFaucet();
            assertEq(gusd.balanceOf(alice), EXPECTED_FAUCET_AMOUNT);
        } else {
            vm.prank(alice);
            gusd.claimFaucet();
            assertEq(gusd.balanceOf(alice), 2 * EXPECTED_FAUCET_AMOUNT);
        }
    }

    /*//////////////////////////////////////////////////////////////
                                  MINT
    //////////////////////////////////////////////////////////////*/

    function test_OwnerCanMint() public {
        vm.prank(owner);
        gusd.mint(alice, 5_000 * ONE_GUSD);

        assertEq(gusd.balanceOf(alice), 5_000 * ONE_GUSD);
        assertEq(gusd.totalSupply(), 5_000 * ONE_GUSD);
    }

    function test_MintRevertsForNonOwner() public {
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        gusd.mint(alice, ONE_GUSD);
    }

    function test_MintRevertsForZeroRecipient() public {
        vm.expectRevert(GUSD.InvalidRecipient.selector);
        vm.prank(owner);
        gusd.mint(address(0), ONE_GUSD);
    }

    function test_MintDoesNotTouchFaucetCooldown() public {
        vm.prank(owner);
        gusd.mint(alice, ONE_GUSD);

        assertEq(gusd.faucetAvailableAt(alice), 0);

        vm.prank(alice);
        gusd.claimFaucet();
        assertEq(gusd.balanceOf(alice), ONE_GUSD + EXPECTED_FAUCET_AMOUNT);
    }

    /*//////////////////////////////////////////////////////////////
                            ERC20 INTEGRATION
    //////////////////////////////////////////////////////////////*/

    function test_FaucetTokensAreTransferable() public {
        vm.prank(alice);
        gusd.claimFaucet();

        vm.prank(alice);
        gusd.transfer(bob, 40 * ONE_GUSD);

        assertEq(gusd.balanceOf(alice), 60 * ONE_GUSD);
        assertEq(gusd.balanceOf(bob), 40 * ONE_GUSD);
    }

    function test_TransferRevertsOnInsufficientBalance() public {
        vm.prank(alice);
        gusd.claimFaucet();

        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, alice, EXPECTED_FAUCET_AMOUNT, 101 * ONE_GUSD
            )
        );
        vm.prank(alice);
        gusd.transfer(bob, 101 * ONE_GUSD);
    }

    /*//////////////////////////////////////////////////////////////
                                UPGRADES
    //////////////////////////////////////////////////////////////*/

    function test_UpgradeToV2PreservesStorage() public {
        // Seed state on V1: a faucet claim (balance + cooldown) and an owner mint.
        vm.prank(alice);
        gusd.claimFaucet();
        vm.prank(owner);
        gusd.mint(bob, 250 * ONE_GUSD);

        uint256 aliceBalanceBefore = gusd.balanceOf(alice);
        uint256 bobBalanceBefore = gusd.balanceOf(bob);
        uint256 totalSupplyBefore = gusd.totalSupply();
        uint256 aliceLastClaimBefore = gusd.lastFaucetClaim(alice);
        uint256 aliceAvailableAtBefore = gusd.faucetAvailableAt(alice);
        address implementationBefore = Upgrades.getImplementationAddress(address(gusd));

        Upgrades.upgradeProxy(
            address(gusd), "GUSD.t.sol:GUSDV2", abi.encodeCall(GUSDV2.initializeV2, (7 * ONE_GUSD)), owner
        );

        GUSDV2 upgraded = GUSDV2(address(gusd));

        // New code is live.
        assertEq(upgraded.version(), "2");
        assertNotEq(Upgrades.getImplementationAddress(address(gusd)), implementationBefore);

        // Metadata and ownership survive.
        assertEq(upgraded.name(), "GiwaCard USD");
        assertEq(upgraded.symbol(), "gUSD");
        assertEq(upgraded.decimals(), 6);
        assertEq(upgraded.owner(), owner);

        // Balances survive.
        assertEq(upgraded.balanceOf(alice), aliceBalanceBefore);
        assertEq(upgraded.balanceOf(bob), bobBalanceBefore);
        assertEq(upgraded.totalSupply(), totalSupplyBefore);

        // Faucet cooldown state survives, and is still enforced.
        assertEq(upgraded.lastFaucetClaim(alice), aliceLastClaimBefore);
        assertEq(upgraded.faucetAvailableAt(alice), aliceAvailableAtBefore);
        vm.expectRevert(abi.encodeWithSelector(GUSD.FaucetCooldownActive.selector, aliceAvailableAtBefore));
        vm.prank(alice);
        upgraded.claimFaucet();

        // Cooldown still clears on schedule after the upgrade.
        vm.warp(aliceAvailableAtBefore);
        vm.prank(alice);
        upgraded.claimFaucet();
        assertEq(upgraded.balanceOf(alice), aliceBalanceBefore + EXPECTED_FAUCET_AMOUNT);

        // New V2 storage was set by the reinitializer and remains writable.
        assertEq(upgraded.faucetBonus(), 7 * ONE_GUSD);
        vm.prank(owner);
        upgraded.setFaucetBonus(9 * ONE_GUSD);
        assertEq(upgraded.faucetBonus(), 9 * ONE_GUSD);

        // The V2 reinitializer cannot be replayed.
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        upgraded.initializeV2(1);
    }

    function test_UpgradeRevertsForNonOwner() public {
        address newImplementation = address(new GUSDV2());

        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        UUPSUpgradeable(address(gusd)).upgradeToAndCall(newImplementation, "");
    }

    function test_UpgradeSucceedsForOwner() public {
        address newImplementation = address(new GUSDV2());

        vm.prank(owner);
        UUPSUpgradeable(address(gusd)).upgradeToAndCall(newImplementation, "");

        assertEq(Upgrades.getImplementationAddress(address(gusd)), newImplementation);
        assertEq(GUSDV2(address(gusd)).version(), "2");
    }

    function test_UpgradeRevertsAfterOwnershipRenounced() public {
        address newImplementation = address(new GUSDV2());

        vm.prank(owner);
        gusd.renounceOwnership();

        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, owner));
        vm.prank(owner);
        UUPSUpgradeable(address(gusd)).upgradeToAndCall(newImplementation, "");
    }
}
