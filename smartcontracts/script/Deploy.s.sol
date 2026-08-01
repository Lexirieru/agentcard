// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {Upgrades} from "openzeppelin-foundry-upgrades/Upgrades.sol";

import {GUSD} from "../src/GUSD.sol";
import {CardVault} from "../src/CardVault.sol";

/// @title Deploy gUSD and CardVault as UUPS proxies on GIWA Sepolia.
/// @notice Run with an imported keystore account rather than a raw private key:
///
///   cast wallet import deployer --interactive
///   forge script script/Deploy.s.sol:Deploy \
///     --account deployer \
///     --rpc-url $GIWA_SEPOLIA_RPC_URL \
///     --broadcast --verify \
///     --verifier blockscout \
///     --verifier-url $BLOCKSCOUT_API_URL
///
/// The verifier URL must carry the trailing `/api`
/// (https://sepolia-explorer.giwa.io/api); Blockscout rejects it otherwise.
/// Verify the implementations before the proxies — Blockscout only offers
/// "Read/Write as Proxy" once the implementation behind the ERC-1967 slot is
/// itself verified.
contract Deploy is Script {
    function run() external returns (address gusdProxy, address vaultProxy) {
        address deployer = msg.sender;

        vm.startBroadcast();

        gusdProxy = Upgrades.deployUUPSProxy("GUSD.sol:GUSD", abi.encodeCall(GUSD.initialize, (deployer)));

        vaultProxy = Upgrades.deployUUPSProxy(
            "CardVault.sol:CardVault", abi.encodeCall(CardVault.initialize, (deployer, gusdProxy))
        );

        vm.stopBroadcast();

        console.log("gUSD proxy:      %s", gusdProxy);
        console.log("gUSD impl:       %s", Upgrades.getImplementationAddress(gusdProxy));
        console.log("CardVault proxy: %s", vaultProxy);
        console.log("CardVault impl:  %s", Upgrades.getImplementationAddress(vaultProxy));
        console.log("Deployer/owner:  %s", deployer);
    }
}
