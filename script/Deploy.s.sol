// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {OracleLagArb} from "../src/OracleLagArb.sol";

/// forge script script/Deploy.s.sol --rpc-url $ETH_RPC_URL --account <keystore> --broadcast
/// 預設是以太坊主網地址；其他鏈用環境變數覆蓋
contract Deploy is Script {
    function run() external returns (OracleLagArb arb) {
        address provider = vm.envOr("AAVE_ADDRESSES_PROVIDER", 0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e);
        address weth = vm.envOr("WETH", 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2);
        address factory = vm.envOr("UNI_V3_FACTORY", 0x1F98431c8aD98523631AE4a59f267346ea31F984);

        vm.startBroadcast();
        arb = new OracleLagArb(provider, weth, factory);
        vm.stopBroadcast();
        console.log("OracleLagArb", address(arb));
    }
}
