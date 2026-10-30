// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OracleLagArb} from "../src/OracleLagArb.sol";
import {
    IAavePool,
    IAaveOracle,
    IACLManager,
    IPoolAddressesProvider,
    IPoolConfigurator,
    IUniswapV3Factory,
    IUniswapV3Pool
} from "../src/interfaces/External.sol";

/// 各條鏈共用的 fork 測試。2026-10-29 Binance 事件後 Aave 把 V3、V4 的 DAO 市場都凍結了，
/// setUp 先用 ACL 權限模擬治理解凍，再用真的 Uniswap 池子製造價差。
/// 子合約用 _net() 給這條鏈的地址；blockEnv 沒設就用最新區塊。
abstract contract ForkBase is Test {
    using SafeERC20 for IERC20;

    struct Net {
        string rpcEnv;
        string rpcDefault;
        string blockEnv;
        address provider;
        address factory;
        address weth;
        address usdc;
        uint24 usdcFee; // 測試用哪個 USDC/WETH 池
        address[] otherStables; // 一起解凍
        address router; // Uniswap SwapRouter02，聚合器路徑的測試用 router
    }

    uint256 constant BPS = 10_000;
    uint256 constant CAPITAL = 100_000e6;
    uint256 constant TARGET_HF = 1.3e18;

    IAavePool aave;
    IAaveOracle oracle;
    OracleLagArb arb;
    address weth;
    address usdc;
    address usdcPool;
    uint24 usdcFee;
    address router;
    address owner = makeAddr("owner");
    address private _pushingPool;

    function _net() internal view virtual returns (Net memory);

    /// 價差 10% 時，利潤至少要是賣出金額的幾 %（池子淺的鏈，賣到價格下限就停，平均價差比較小）
    function _minProfitPct() internal pure virtual returns (uint256) {
        return 3;
    }

    function setUp() public virtual {
        Net memory n = _net();
        string memory rpc = vm.envOr(n.rpcEnv, n.rpcDefault);
        uint256 forkBlock = vm.envOr(n.blockEnv, uint256(0));
        if (forkBlock == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, forkBlock);

        (weth, usdc, usdcFee, router) = (n.weth, n.usdc, n.usdcFee, n.router);
        usdcPool = IUniswapV3Factory(n.factory).getPool(weth, usdc, usdcFee);
        IPoolAddressesProvider provider = IPoolAddressesProvider(n.provider);
        aave = IAavePool(provider.getPool());
        oracle = IAaveOracle(provider.getPriceOracle());
        _unfreeze(provider, n.otherStables);

        vm.prank(owner);
        arb = new OracleLagArb(n.provider, weth, n.factory);
        vm.prank(owner);
        arb.setRouter(router, true);
        _deposit(usdc, CAPITAL);
    }

    // ───────────────────────────── 主流程 ─────────────────────────────

    /// 事件重演：Uniswap 比預言機貴 10% → open → Uniswap 跌回預言機價 → close → 賺到價差
    function test_profitWhenUniswapConvergesDown() public {
        _pushWethPrice(usdcPool, BPS + 1000);
        console.log("premium before open (bps)", arb.premiumBps(usdcPool));

        vm.prank(owner);
        (uint256 sold, uint256 received) = arb.open(usdcPool, 50, 50, TARGET_HF, 0);

        assertGt(sold, 0);
        assertApproxEqAbs(arb.wethDebt(), sold, 2);
        assertGe(arb.healthFactor(), TARGET_HF);
        // 平均賣價至少比預言機高 0.5%（USDC 在各鏈都是 6 位小數）
        assertGe(received * 1e12 * oracle.getAssetPrice(usdc) * BPS, sold * oracle.getAssetPrice(weth) * (BPS + 50));
        console.log("WETH sold", sold);
        console.log("USDC received", received);
        console.log("HF after open", arb.healthFactor());

        vm.warp(block.timestamp + 1 days); // 抱一天，算進借款利息
        _setPremium(usdcPool, 0);

        // 買回會把池子推高；上限給 1%，免得只買回一部分就停
        vm.prank(owner);
        (uint256 bought, uint256 paid) = arb.close(usdcPool, 100, 0);
        assertEq(arb.wethDebt(), 0);
        assertGt(bought, sold); // 本金 + 一天利息
        console.log("USDC paid to buy back", paid);

        uint256 finalUsdc = _withdrawAll(usdc);
        console.log("profit (USDC)", int256(finalUsdc) - int256(CAPITAL));
        assertGt(finalUsdc, CAPITAL + received * _minProfitPct() / 100);
    }

    /// 估規模時假設的價差越大，第一筆賣越多；健康因子照樣守住
    function test_open_sizingEdgeSellsMore() public {
        _pushWethPrice(usdcPool, BPS + 1000);
        uint256 snap = vm.snapshotState();
        vm.prank(owner);
        (uint256 soldWorstCase,) = arb.open(usdcPool, 50, 50, TARGET_HF, 0);
        vm.revertToState(snap);
        vm.prank(owner);
        (uint256 soldSized,) = arb.open(usdcPool, 50, 500, TARGET_HF, 0);
        console.log("sold with sizingEdge 0.5% / 5%", soldWorstCase, soldSized);
        assertGt(soldSized, soldWorstCase * 105 / 100);
        assertGe(arb.healthFactor(), TARGET_HF);
    }

    /// 合約手上閒置的穩定幣（例如 Aave 提不出來時直接轉進來的）平倉時先用
    function test_close_usesIdleStableFirst() public {
        _pushWethPrice(usdcPool, BPS + 1000);
        vm.prank(owner);
        arb.open(usdcPool, 50, 50, TARGET_HF, 0);
        _setPremium(usdcPool, 0);
        deal(usdc, address(arb), 10_000e6);
        address aToken = aave.getReserveData(usdc).aTokenAddress;
        uint256 aBefore = IERC20(aToken).balanceOf(address(arb));

        vm.prank(owner);
        (, uint256 paid) = arb.close(usdcPool, 100, 0);
        assertEq(arb.wethDebt(), 0);
        assertEq(IERC20(usdc).balanceOf(address(arb)), 0);
        // 從 Aave 提出來的只有不夠的那部分
        assertApproxEqAbs(aBefore - IERC20(aToken).balanceOf(address(arb)), paid - 10_000e6, 2);
    }

    function test_open_revertsWithoutPremium() public {
        vm.prank(owner);
        vm.expectPartialRevert(OracleLagArb.NoEdge.selector);
        arb.open(usdcPool, 50, 50, TARGET_HF, 0);
    }

    /// 抵押全是穩定幣、債全是 WETH，健康因子跟預言機價成反比：HF = h 時，預言機漲 (h − 1) 就會被清算
    function test_oracleUpByHfMinusOne_liquidatable() public {
        _pushWethPrice(usdcPool, BPS + 1000);
        vm.prank(owner);
        arb.open(usdcPool, 50, 50, TARGET_HF, 0);

        uint256 hf = arb.healthFactor();
        uint256 price = oracle.getAssetPrice(weth);
        console.log("HF after open", hf);
        _mockWethOraclePrice(price * hf / 1e18 * 99 / 100);
        assertGt(arb.healthFactor(), 1e18);
        _mockWethOraclePrice(price * hf / 1e18 * 101 / 100);
        assertLt(arb.healthFactor(), 1e18);
    }

    // ───────────────────────── 聚合器路徑（Aave flash loan） ─────────────────────────

    /// 回呼只接受「Aave、自己發起、而且正在進行中」的 flash loan
    function test_flashCallbacks_rejectOutsiders() public {
        address[] memory a = new address[](1);
        uint256[] memory n = new uint256[](1);
        bytes memory params = abi.encode(usdc, uint256(50), router, bytes(""));
        vm.expectRevert(OracleLagArb.UnauthorizedFlashLoan.selector);
        arb.executeOperation(a, n, n, address(arb), params); // 不是 Aave 呼叫的
        vm.prank(address(aave));
        vm.expectRevert(OracleLagArb.UnauthorizedFlashLoan.selector);
        arb.executeOperation(a, n, n, address(this), params); // 別人發起的
        vm.prank(address(aave));
        vm.expectRevert(OracleLagArb.UnauthorizedFlashLoan.selector);
        arb.executeOperation(a, n, n, address(arb), params); // 不在自己的 flash loan 裡
        vm.prank(address(aave));
        vm.expectRevert(OracleLagArb.UnauthorizedFlashLoan.selector);
        arb.executeOperation(weth, 1 ether, 0, address(arb), params);
    }

    /// 真的有人用 Aave flash loan 把這個合約當收款人：整筆失敗，合約不會去呼叫 router
    function test_flashCallbacks_rejectForeignFlashLoan() public {
        address attacker = makeAddr("attacker");
        bytes memory params = abi.encode(usdc, uint256(0), uint256(10_000), router, bytes(""));
        vm.prank(attacker);
        vm.expectRevert();
        aave.flashLoanSimple(address(arb), weth, 1 ether, params, 0);
    }

    function test_openVia_guards() public {
        vm.expectRevert(OracleLagArb.NotOwner.selector);
        arb.openVia(usdc, 1 ether, 50, TARGET_HF, router, "");
        vm.prank(owner);
        vm.expectRevert(OracleLagArb.RouterNotAllowed.selector);
        arb.openVia(usdc, 1 ether, 50, TARGET_HF, makeAddr("evil router"), "");
        vm.expectRevert(OracleLagArb.NotOwner.selector);
        arb.setRouter(makeAddr("evil router"), true);
    }

    /// 沒價差時用 router 賣：換到的 stable 不到「預言機價 × 1.005」，整筆 revert
    function test_openVia_revertsBelowEdge() public {
        vm.prank(owner);
        vm.expectPartialRevert(OracleLagArb.PriceBelowLimit.selector);
        arb.openVia(usdc, 10 ether, 50, TARGET_HF, router, _sell(weth, usdc, 10 ether));
    }

    /// 借太多（健康因子撐不住）：整筆 revert
    function test_openVia_revertsWhenTooBig() public {
        _pushWethPrice(usdcPool, BPS + 1000);
        vm.prank(owner);
        vm.expectRevert();
        arb.openVia(usdc, 500 ether, 50, TARGET_HF, router, _sell(weth, usdc, 500 ether));
    }

    function test_openVia_thenCloseVia() public {
        _pushWethPrice(usdcPool, BPS + 1000);
        address aToken = aave.getReserveData(usdc).aTokenAddress;
        uint256 aBefore = IERC20(aToken).balanceOf(address(arb));

        vm.prank(owner);
        uint256 received = arb.openVia(usdc, 20 ether, 50, TARGET_HF, router, _sell(weth, usdc, 20 ether));
        console.log("openVia: 20 WETH ->", received);
        assertApproxEqAbs(arb.wethDebt(), 20 ether, 2);
        assertApproxEqAbs(IERC20(aToken).balanceOf(address(arb)) - aBefore, received, 2);
        assertGe(received * 1e12 * oracle.getAssetPrice(usdc) * BPS, 20 ether * oracle.getAssetPrice(weth) * (BPS + 50));
        assertGe(arb.healthFactor(), TARGET_HF);
        assertEq(IERC20(weth).allowance(address(arb), router), 0);
        assertEq(IERC20(weth).balanceOf(address(arb)), 0);

        _setPremium(usdcPool, 0);
        uint256 debt = arb.wethDebt();
        // 要換回 債 + flash loan 手續費（0.05%），照預言機價多給 1% 當滑價
        uint256 stableIn = (debt * 10_005 / 10_000) * oracle.getAssetPrice(weth) * 101 / (oracle.getAssetPrice(usdc) * 1e12 * 100);

        vm.prank(owner);
        vm.expectPartialRevert(OracleLagArb.PriceAboveLimit.selector); // 上限 0.5% 時給 1% 不行
        arb.closeVia(usdc, debt, stableIn, 50, router, _sell(usdc, weth, stableIn));

        vm.prank(owner);
        uint256 repaid = arb.closeVia(usdc, debt, stableIn, 200, router, _sell(usdc, weth, stableIn));
        console.log("closeVia: repaid WETH", repaid);
        assertEq(arb.wethDebt(), 0);
        assertEq(IERC20(usdc).allowance(address(arb), router), 0);
        uint256 finalUsdc = _withdrawAll(usdc);
        console.log("profit via router (USDC)", int256(finalUsdc) - int256(CAPITAL));
        assertGt(finalUsdc, CAPITAL);
    }

    /// SwapRouter02.exactInputSingle 的 calldata，收款人是合約
    function _sell(address tokenIn, address tokenOut, uint256 amountIn) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            ISwapRouter02.exactInputSingle.selector,
            ISwapRouter02.ExactInputSingleParams(tokenIn, tokenOut, usdcFee, address(arb), amountIn, 0, 0)
        );
    }

    // ───────────────────────────── 權限 ─────────────────────────────

    function test_onlyOwner() public {
        vm.expectRevert(OracleLagArb.NotOwner.selector);
        arb.open(usdcPool, 50, 50, TARGET_HF, 0);
        vm.expectRevert(OracleLagArb.NotOwner.selector);
        arb.close(usdcPool, 30, 0);
        vm.expectRevert(OracleLagArb.NotOwner.selector);
        arb.withdraw(usdc, 1, address(this));
        vm.expectRevert(OracleLagArb.NotOwner.selector);
        arb.sweep(usdc, address(this));
        vm.expectRevert(OracleLagArb.NotOwner.selector);
        arb.setCollateral(usdc, false);
    }

    /// 真的池子在 swap 以外呼叫 callback 也不行
    function test_callbackOnlyDuringOwnSwap() public {
        bytes memory data = abi.encode(usdc, false, true);
        vm.expectRevert(OracleLagArb.UnauthorizedCallback.selector);
        arb.uniswapV3SwapCallback(-1e6, 1 ether, data);

        vm.prank(usdcPool);
        vm.expectRevert(OracleLagArb.UnauthorizedCallback.selector);
        arb.uniswapV3SwapCallback(-1e6, 1 ether, data);
    }

    /// 長得像 WETH/USDC 池、但不是 factory 建的，直接拒絕
    function test_rejectsPoolNotFromFactory() public {
        FakePool fake = new FakePool(usdc, weth, usdcFee);
        vm.prank(owner);
        vm.expectRevert(OracleLagArb.BadPool.selector);
        arb.open(address(fake), 50, 50, TARGET_HF, 0);
    }

    // ───────────────────────────── 工具 ─────────────────────────────

    /// 模擬治理解凍：拿 PoolAdmin 角色，把 WETH 和穩定幣解凍；穩定幣的 LTV 沒回來就設回 75%
    function _unfreeze(IPoolAddressesProvider provider, address[] memory otherStables) internal {
        IACLManager acl = IACLManager(provider.getACLManager());
        vm.prank(provider.getACLAdmin());
        acl.addPoolAdmin(address(this));
        IPoolConfigurator cfg = IPoolConfigurator(provider.getPoolConfigurator());
        address[] memory stables = new address[](otherStables.length + 1);
        stables[0] = usdc;
        for (uint256 i; i < otherStables.length; i++) {
            stables[i + 1] = otherStables[i];
        }
        cfg.setReserveFreeze(weth, false);
        for (uint256 i; i < stables.length; i++) {
            cfg.setReserveFreeze(stables[i], false);
            uint256 c = aave.getConfiguration(stables[i]);
            if (c & 0xFFFF == 0) cfg.configureReserveAsCollateral(stables[i], 7500, (c >> 16) & 0xFFFF, (c >> 32) & 0xFFFF);
        }
    }

    function _deposit(address token, uint256 amount) internal {
        deal(token, owner, amount);
        vm.startPrank(owner);
        IERC20(token).forceApprove(address(arb), amount);
        arb.deposit(token, amount);
        vm.stopPrank();
    }

    function _withdrawAll(address token) internal returns (uint256) {
        if (IERC20(aave.getReserveData(token).aTokenAddress).balanceOf(address(arb)) == 0) return 0;
        uint256 before = IERC20(token).balanceOf(owner);
        vm.prank(owner);
        arb.withdraw(token, type(uint256).max, owner);
        return IERC20(token).balanceOf(owner) - before;
    }

    function _mockWethOraclePrice(uint256 price) internal {
        vm.mockCall(address(oracle), abi.encodeWithSelector(IAaveOracle.getAssetPrice.selector, weth), abi.encode(price));
    }

    /// 讓 Uniswap 價格剛好比預言機高 targetBps
    function _setPremium(address pool, int256 targetBps) internal {
        int256 current = arb.premiumBps(pool);
        _pushWethPrice(pool, uint256((int256(BPS) + targetBps) * int256(BPS) / (int256(BPS) + current)));
    }

    /// 用 deal 出來的錢在池子裡交易，把 WETH 的穩定幣價格乘上 factorBps / 1e4
    function _pushWethPrice(address pool, uint256 factorBps) internal {
        bool wethIsToken0 = IUniswapV3Pool(pool).token0() == weth;
        (uint160 current,,,,,,) = IUniswapV3Pool(pool).slot0();
        // WETH 是 token0 時 price = 穩定幣/WETH，sqrt 跟著乘；反之要除
        uint256 ratio = wethIsToken0 ? factorBps * 1e36 / BPS : BPS * 1e36 / factorBps;
        uint160 target = uint160(Math.mulDiv(current, Math.sqrt(ratio), 1e18));
        _pushingPool = pool;
        IUniswapV3Pool(pool).swap(address(this), target < current, type(int128).max, target, "");
        _pushingPool = address(0);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        require(msg.sender == _pushingPool, "not pushing");
        if (amount0Delta > 0) _pay(IUniswapV3Pool(msg.sender).token0(), uint256(amount0Delta));
        if (amount1Delta > 0) _pay(IUniswapV3Pool(msg.sender).token1(), uint256(amount1Delta));
    }

    function _pay(address token, uint256 amount) internal {
        deal(token, address(this), IERC20(token).balanceOf(address(this)) + amount);
        IERC20(token).safeTransfer(msg.sender, amount);
    }
}

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

contract FakePool {
    address public token0;
    address public token1;
    uint24 public fee;

    constructor(address t0, address t1, uint24 f) {
        (token0, token1, fee) = (t0, t1, f);
    }
}
