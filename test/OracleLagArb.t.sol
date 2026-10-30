// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.28;

import {console} from "forge-std/Test.sol";
import {OracleLagArb} from "../src/OracleLagArb.sol";
import {ForkBase} from "./ForkBase.sol";

/// 以太坊主網：共用測試之外，再測 WETH 是 token0 的池子（USDT）、價格下限、單筆上限、預言機往上收斂
contract MainnetForkTest is ForkBase {
    address constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    address constant WETH_USDT_030 = 0x4e68Ccd3E89f51C3074ca5072bbAC773960dFa36; // token0 = WETH

    function _net() internal pure override returns (Net memory n) {
        n.rpcEnv = "ETH_RPC_URL";
        n.rpcDefault = "https://ethereum-rpc.publicnode.com";
        n.blockEnv = "FORK_BLOCK";
        n.provider = 0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e;
        n.factory = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
        n.weth = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
        n.usdc = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
        n.usdcFee = 500;
        n.otherStables = new address[](1);
        n.otherStables[0] = USDT;
        n.router = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;
    }

    /// 主網 0.05% 池很深，賣完價差幾乎還在，利潤要有賣出金額的 7%
    function _minProfitPct() internal pure override returns (uint256) {
        return 7;
    }

    /// 另一種幣序（WETH 是 token0）＋ USDT 當抵押
    function test_profitOnWethToken0Pool() public {
        _pushWethPrice(WETH_USDT_030, BPS + 500);

        vm.prank(owner);
        (uint256 sold, uint256 received) = arb.open(WETH_USDT_030, 50, 50, TARGET_HF, 0);
        assertGt(sold, 0);
        assertGe(arb.healthFactor(), TARGET_HF);

        _setPremium(WETH_USDT_030, 0);
        vm.prank(owner);
        (, uint256 paid) = arb.close(WETH_USDT_030, 30, 0);
        assertEq(arb.wethDebt(), 0);

        uint256 usdtLeft = _withdrawAll(USDT);
        // Aave 每次存、提都有 1 wei 等級的捨入，方向對協議有利
        assertLe(usdtLeft, received - paid);
        assertGe(usdtLeft, received - paid - 10);
        assertGt(usdtLeft, received * 3 / 100);
        console.log("profit (USDT)", usdtLeft);
    }

    /// 價差小、本金大：賣到 Uniswap 只剩 minEdge 就停，不會把價格砸穿
    function test_open_stopsAtPriceLimit() public {
        _deposit(usdc, 2_000_000e6);
        _pushWethPrice(usdcPool, BPS + 100);

        uint256 hfCap = arb.maxWethForHealthFactor(usdc, 50, TARGET_HF);
        vm.prank(owner);
        (uint256 sold,) = arb.open(usdcPool, 50, 50, TARGET_HF, 0);

        assertLt(sold, hfCap);
        // 價格下限有算手續費：停在 (1 + 0.5%) / (1 − 0.05%) ≈ +0.55%，扣掉手續費剛好 +0.5%
        assertApproxEqAbs(arb.premiumBps(usdcPool), 55, 1);
        assertGt(arb.healthFactor(), TARGET_HF);
    }

    /// 審查 C1 的情境：倉位一部分開在 USDC 池、大部分開在 USDT 池，USDC 抵押不夠一次還清全部債。
    /// 以前 close 會整筆 revert（平不掉）；現在付得起多少平多少，輪流用兩種穩定幣平到債務歸零
    function test_crossStable_closesInChunks() public {
        _pushWethPrice(usdcPool, BPS + 1000);
        vm.prank(owner);
        arb.open(usdcPool, 50, 50, TARGET_HF, 5 ether);
        _pushWethPrice(WETH_USDT_030, BPS + 1000);
        vm.prank(owner);
        arb.open(WETH_USDT_030, 50, 50, TARGET_HF, 0);
        _setPremium(usdcPool, 0);
        _setPremium(WETH_USDT_030, 0);

        uint256 debt = arb.wethDebt();
        assertLt(arb.wethAffordable(usdc, 500, 100), debt, "USDC alone cannot repay everything");
        vm.prank(owner);
        (uint256 bought,) = arb.close(usdcPool, 100, 0);
        assertLt(bought, debt, "first close is partial instead of reverting");
        assertGt(bought, 0);

        for (uint256 i; i < 6 && arb.wethDebt() > 0; i++) {
            vm.prank(owner);
            try arb.close(i % 2 == 0 ? WETH_USDT_030 : usdcPool, 100, 0) {} catch {}
        }
        assertEq(arb.wethDebt(), 0);
        uint256 total = _withdrawAll(usdc) + _withdrawAll(USDT); // 兩種都是 6 位小數、約 1 美元
        console.log("USDC + USDT after cross-stable round trip", total);
        assertGt(total, CAPITAL);
    }

    function test_open_respectsMaxWethIn() public {
        _pushWethPrice(usdcPool, BPS + 1000);
        vm.prank(owner);
        (uint256 sold,) = arb.open(usdcPool, 50, 50, TARGET_HF, 1 ether);
        assertEq(sold, 1 ether);
    }

    /// 收斂方向錯了：Uniswap 沒跌，是預言機漲上來。平倉只是把賣出的價錢買回來，沒有利潤，還要付手續費
    function test_oracleCatchesUp_noProfit() public {
        _pushWethPrice(usdcPool, BPS + 1000);
        vm.prank(owner);
        (, uint256 received) = arb.open(usdcPool, 50, 50, TARGET_HF, 0);
        uint256 hfBefore = arb.healthFactor();

        _mockWethOraclePrice(oracle.getAssetPrice(weth) * 110 / 100);
        assertLt(arb.healthFactor(), hfBefore * 100 / 108);
        console.log("HF after oracle +10%", arb.healthFactor());

        vm.prank(owner);
        arb.close(usdcPool, 30, 0);
        assertEq(arb.wethDebt(), 0);
        uint256 finalUsdc = _withdrawAll(usdc);
        console.log("PnL (USDC)", int256(finalUsdc) - int256(CAPITAL));
        assertLt(finalUsdc, CAPITAL);
        assertGt(finalUsdc, CAPITAL - received / 100);
    }
}
