// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ForkBase} from "./ForkBase.sol";

// L2 跑共用測試。地址 2026-10-30 從鏈上核對過（Aave PoolAddressesProvider → getPool / getReserveData，Uniswap factory → getPool）。
// 公開 RPC 的選擇：publicnode 的 Arbitrum／Optimism 只給最近 128 個區塊的狀態（Arbitrum 只有約 30 秒），測試跑不完，所以用官方 RPC。

contract ArbitrumForkTest is ForkBase {
    function _net() internal pure override returns (Net memory n) {
        n.rpcEnv = "ARB_RPC_URL";
        n.rpcDefault = "https://arb1.arbitrum.io/rpc";
        n.blockEnv = "ARB_FORK_BLOCK";
        n.provider = 0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb;
        n.factory = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
        n.weth = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
        n.usdc = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831; // 原生 USDC；WETH 是 token0
        n.usdcFee = 500;
        n.otherStables = new address[](1);
        n.otherStables[0] = 0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9; // USDT
        n.router = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;
    }
}

contract BaseForkTest is ForkBase {
    function _net() internal pure override returns (Net memory n) {
        n.rpcEnv = "BASE_RPC_URL";
        n.rpcDefault = "https://base-rpc.publicnode.com";
        n.blockEnv = "BASE_FORK_BLOCK";
        n.provider = 0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D;
        n.factory = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
        n.weth = 0x4200000000000000000000000000000000000006;
        n.usdc = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913; // WETH 是 token0；Aave 在 Base 沒有 USDT
        n.usdcFee = 500;
        n.router = 0x2626664c2603336E57B271c5C0b26F421741e481;
    }
}

contract OptimismForkTest is ForkBase {
    function _net() internal pure override returns (Net memory n) {
        n.rpcEnv = "OP_RPC_URL";
        n.rpcDefault = "https://mainnet.optimism.io";
        n.blockEnv = "OP_FORK_BLOCK";
        n.provider = 0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb;
        n.factory = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
        n.weth = 0x4200000000000000000000000000000000000006;
        n.usdc = 0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85; // 原生 USDC；USDC 是 token0
        n.usdcFee = 3000; // 0.05% 池只有約 80 WETH，0.3% 池比較深
        n.otherStables = new address[](1);
        n.otherStables[0] = 0x94b008aA00579c1307B0EF2c499aD98a8ce58e58; // USDT
        n.router = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;
    }
}
