// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {
    IAavePool,
    IAaveOracle,
    IPoolAddressesProvider,
    IUniswapV3Factory,
    IUniswapV3Pool
} from "./interfaces/External.sol";

/// @title OracleLagArb
/// @notice Uniswap 上的 ETH 比 Aave 預言機貴的時候：
///   open : 在 Uniswap 賣 WETH（貴）→ 收到的穩定幣存進 Aave → 照預言機價（便宜）借 WETH 付給 Uniswap
///   close: 在 Uniswap 買回 WETH → 還 Aave 的 WETH 債 → 從 Aave 提穩定幣付給 Uniswap
/// 兩個方向都用 Uniswap V3 flash swap，一筆交易做完「存 U → 借 ETH → 賣 → 再存」的整個循環。
/// 賣出時用 sqrtPriceLimitX96 卡在「預言機價 × (1 + minEdge)」，Uniswap 價格被壓到這條線就自動停，
/// 所以每一顆 WETH 的賣價都至少比預言機高 minEdge。
/// 部位記在這個合約名下（Aave 的 user = address(this)），只有 owner 能操作。
contract OracleLagArb {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;
    uint256 private constant VARIABLE_RATE = 2;

    IAavePool public immutable AAVE;
    IAaveOracle public immutable ORACLE;
    IUniswapV3Factory public immutable UNI_FACTORY;
    address public immutable WETH;
    address public immutable WETH_DEBT_TOKEN;
    address public immutable owner;

    /// 正在 swap 的池子；callback 只接受它
    address private transient _activePool;
    /// 聚合器（呼叫對象）白名單，只有 owner 能改
    mapping(address => bool) public routers;
    /// 自己發起的 Aave flash loan 進行中：1 = openVia、2 = closeVia。executeOperation 只在這時候接受回呼，
    /// 不然別人可以用自己的 flash loan 把這個合約當收款人，逼它去呼叫 router
    uint8 private transient _flashMode;
    uint256 private transient _flashOut;

    error NotOwner();
    error BadPool();
    error UnauthorizedCallback();
    error NoEdge(uint160 sqrtPriceX96, uint160 sqrtPriceLimitX96);
    error HealthFactorTooLow(uint256 healthFactor);
    error NothingToDo();
    error RouterNotAllowed();
    error UnauthorizedFlashLoan();
    error PriceBelowLimit(uint256 got, uint256 min);
    error PriceAboveLimit(uint256 paid, uint256 max);

    event Opened(address indexed pool, uint256 wethSold, uint256 stableReceived, uint256 healthFactor);
    event Closed(address indexed pool, uint256 wethBought, uint256 stablePaid, uint256 healthFactor);
    event RouterSet(address indexed router, bool allowed);
    event OpenedVia(address indexed router, address indexed stable, uint256 wethSold, uint256 stableReceived, uint256 healthFactor);
    event ClosedVia(address indexed router, address indexed stable, uint256 wethRepaid, uint256 stablePaid, uint256 healthFactor);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address addressesProvider, address weth, address uniswapV3Factory) {
        IPoolAddressesProvider provider = IPoolAddressesProvider(addressesProvider);
        AAVE = IAavePool(provider.getPool());
        ORACLE = IAaveOracle(provider.getPriceOracle());
        UNI_FACTORY = IUniswapV3Factory(uniswapV3Factory);
        WETH = weth;
        WETH_DEBT_TOKEN = AAVE.getReserveData(weth).variableDebtTokenAddress;
        owner = msg.sender;
        IERC20(weth).forceApprove(address(AAVE), type(uint256).max);
    }

    // ───────────────────────────── 交易 ─────────────────────────────

    /// @notice 在 uniPool 賣 WETH、在 Aave 借 WETH 補上，賣到價差剩 minEdgeBps 或健康因子剩 targetHf 為止
    /// @param uniPool        Uniswap V3 的 WETH/穩定幣池；穩定幣會變成 Aave 抵押品
    /// @param minEdgeBps     扣掉池子手續費後，每顆 WETH 至少要比預言機貴這麼多才賣（50 = 0.5%）
    /// @param sizingEdgeBps  估這一筆能賣多少時，假設平均賣價比預言機高多少；小於 minEdgeBps 時用 minEdgeBps。
    ///                       估太大只會讓下面的健康因子檢查 revert，不會虧錢
    /// @param targetHf       賣完後的健康因子下限（1e18 = 1.0）
    /// @param maxWethIn      這一筆最多賣多少 WETH；0 = 只受 targetHf 和價格限制
    function open(address uniPool, uint256 minEdgeBps, uint256 sizingEdgeBps, uint256 targetHf, uint256 maxWethIn)
        external
        onlyOwner
        returns (uint256 wethSold, uint256 stableReceived)
    {
        (address stable, bool wethIsToken0, uint24 fee) = _checkPool(uniPool);

        uint256 wethIn = maxWethForHealthFactor(stable, Math.max(minEdgeBps, sizingEdgeBps), targetHf);
        if (maxWethIn != 0 && maxWethIn < wethIn) wethIn = maxWethIn;
        if (wethIn == 0) revert NothingToDo();

        // 池子會先扣手續費：成交價要再高 1/(1−fee)，扣完才有 minEdge
        uint160 limit =
            _oracleSqrtPriceX96(stable, wethIsToken0, (BPS + minEdgeBps) * 1e6, BPS * (1e6 - uint256(fee)));
        (int256 wethDelta, int256 stableDelta) =
            _swap(uniPool, stable, wethIsToken0, true, int256(Math.min(wethIn, uint256(type(int256).max))), limit);
        wethSold = uint256(wethDelta);
        stableReceived = uint256(-stableDelta);

        uint256 hf = healthFactor();
        if (hf < targetHf) revert HealthFactorTooLow(hf);
        emit Opened(uniPool, wethSold, stableReceived, hf);
    }

    /// @notice 在 uniPool 買回 WETH 還債，價格超過「預言機價 × (1 + maxPremiumBps)」就停。
    ///         一次最多買回付得起的量（見 wethAffordable），付不起全部時只平一部分，換另一種穩定幣的池子再平
    /// @param maxPremiumBps 平常設小（例 30）只在價差收斂後買；要緊急降槓桿就設大（例 1000）
    /// @param maxWethOut    這一筆最多買回多少 WETH；0 = 全部債務
    function close(address uniPool, uint256 maxPremiumBps, uint256 maxWethOut)
        external
        onlyOwner
        returns (uint256 wethBought, uint256 stablePaid)
    {
        (address stable, bool wethIsToken0, uint24 fee) = _checkPool(uniPool);

        uint256 wethOut = wethDebt();
        if (maxWethOut != 0 && maxWethOut < wethOut) wethOut = maxWethOut;
        uint256 affordable = wethAffordable(stable, fee, maxPremiumBps);
        if (affordable < wethOut) wethOut = affordable;
        if (wethOut == 0) revert NothingToDo();

        uint160 limit = _oracleSqrtPriceX96(stable, wethIsToken0, BPS + maxPremiumBps, BPS);
        (int256 wethDelta, int256 stableDelta) = _swap(uniPool, stable, wethIsToken0, false, -int256(wethOut), limit);
        wethBought = uint256(-wethDelta);
        stablePaid = uint256(stableDelta);

        emit Closed(uniPool, wethBought, stablePaid, healthFactor());
    }

    /// @dev 正數 = 我們欠池子，負數 = 池子已經給我們
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        if (msg.sender != _activePool) revert UnauthorizedCallback();
        (address stable, bool wethIsToken0, bool selling) = abi.decode(data, (address, bool, bool));
        (int256 wethDelta, int256 stableDelta) =
            wethIsToken0 ? (amount0Delta, amount1Delta) : (amount1Delta, amount0Delta);

        if (selling) {
            // 已收到穩定幣，欠池子 WETH：存進 Aave 當抵押，借 WETH 付回去
            _supply(stable, uint256(-stableDelta));
            AAVE.borrow(WETH, uint256(wethDelta), VARIABLE_RATE, 0, address(this));
            IERC20(WETH).safeTransfer(msg.sender, uint256(wethDelta));
        } else {
            // 已收到 WETH，欠池子穩定幣：先還債，再付穩定幣。合約手上有閒置的先用，不夠才從 Aave 提
            AAVE.repay(WETH, uint256(-wethDelta), VARIABLE_RATE, address(this));
            uint256 owed = uint256(stableDelta);
            uint256 own = Math.min(IERC20(stable).balanceOf(address(this)), owed);
            if (own > 0) IERC20(stable).safeTransfer(msg.sender, own);
            if (owed > own) AAVE.withdraw(stable, owed - own, msg.sender);
        }
    }

    // ─────────────────────── 聚合器路徑（Aave flash loan） ───────────────────────
    // 讓聚合器（KyberSwap 等）幫忙找最好的成交：可以同時賣到 Uniswap V3／V4、Aerodrome、Curve、做市商報價。
    // 三個保護讓它不比直接 flash swap 危險：router 白名單、只授權這次的量而且用完歸零、成交價在鏈上用預言機檢查（量餘額差，不信回傳值）。

    function setRouter(address router, bool allowed) external onlyOwner {
        routers[router] = allowed;
        emit RouterSet(router, allowed);
    }

    /// @notice 用聚合器賣 WETH 開倉：Aave flashLoan 模式 2 借 wethAmount 顆 WETH（不用還，結束時直接變成浮動利率債），
    ///         交給 router 換成 stable，換到的全部存進 Aave
    /// @param swapData 給 router 的 calldata（收款人要是這個合約），WETH → stable、賣 wethAmount 顆
    /// @param minEdgeBps 換到的 stable 至少要「wethAmount × 預言機價 × (1 + minEdge)」，不到就整筆 revert
    function openVia(
        address stable,
        uint256 wethAmount,
        uint256 minEdgeBps,
        uint256 targetHf,
        address router,
        bytes calldata swapData
    ) external onlyOwner returns (uint256 stableReceived) {
        if (!routers[router]) revert RouterNotAllowed();
        if (wethAmount == 0) revert NothingToDo();
        _flashMode = 1;
        _borrowViaFlash(wethAmount, abi.encode(stable, minEdgeBps, router, swapData));
        _flashMode = 0;
        stableReceived = _flashOut;

        // router 沒用完的 WETH 拿去還債（債在 flashLoan 結束時才開）
        uint256 left = IERC20(WETH).balanceOf(address(this));
        if (left > 0) AAVE.repay(WETH, left, VARIABLE_RATE, address(this));
        uint256 hf = healthFactor();
        if (hf < targetHf) revert HealthFactorTooLow(hf);
        emit OpenedVia(router, stable, wethAmount - Math.min(left, wethAmount), stableReceived, hf);
    }

    /// @notice 用聚合器買回 WETH 還債：Aave flashLoanSimple（要付 flash loan 手續費，目前 0.05%）借 wethAmount 顆 WETH 先還債，
    ///         再拿 stableIn 的 stable（合約手上閒置的先用，不夠才從 Aave 提）交給 router 換回 WETH 還 flash loan；多換的 WETH 再拿去還債
    /// @param swapData 給 router 的 calldata（收款人要是這個合約），stable → WETH、賣 stableIn
    /// @param maxPremiumBps stableIn 不能超過「(wethAmount + 手續費) × 預言機價 × (1 + maxPremium)」
    function closeVia(
        address stable,
        uint256 wethAmount,
        uint256 stableIn,
        uint256 maxPremiumBps,
        address router,
        bytes calldata swapData
    ) external onlyOwner returns (uint256 wethRepaid) {
        if (!routers[router]) revert RouterNotAllowed();
        uint256 debtBefore = wethDebt();
        if (wethAmount > debtBefore) wethAmount = debtBefore;
        if (wethAmount == 0) revert NothingToDo();

        _flashMode = 2;
        AAVE.flashLoanSimple(address(this), WETH, wethAmount, abi.encode(stable, stableIn, maxPremiumBps, router, swapData), 0);
        _flashMode = 0;

        uint256 left = IERC20(WETH).balanceOf(address(this));
        if (left > 0 && wethDebt() > 0) AAVE.repay(WETH, left, VARIABLE_RATE, address(this));
        wethRepaid = debtBefore - wethDebt();
        emit ClosedVia(router, stable, wethRepaid, _flashOut, healthFactor());
    }

    /// @dev openVia 的回呼（Aave flashLoan）
    function executeOperation(
        address[] calldata,
        uint256[] calldata amounts,
        uint256[] calldata,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        if (msg.sender != address(AAVE) || initiator != address(this) || _flashMode != 1) revert UnauthorizedFlashLoan();
        (address stable, uint256 minEdgeBps, address router, bytes memory swapData) =
            abi.decode(params, (address, uint256, address, bytes));
        uint256 got = _swapVia(router, WETH, amounts[0], stable, swapData);
        uint256 min = _stableFor(stable, amounts[0], BPS + minEdgeBps);
        if (got < min) revert PriceBelowLimit(got, min);
        _supply(stable, got);
        _flashOut = got;
        return true;
    }

    /// @dev closeVia 的回呼（Aave flashLoanSimple）
    function executeOperation(address, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external
        returns (bool)
    {
        if (msg.sender != address(AAVE) || initiator != address(this) || _flashMode != 2) revert UnauthorizedFlashLoan();
        (address stable, uint256 stableIn, uint256 maxPremiumBps, address router, bytes memory swapData) =
            abi.decode(params, (address, uint256, uint256, address, bytes));
        AAVE.repay(WETH, amount, VARIABLE_RATE, address(this));

        uint256 max = _stableFor(stable, amount + premium, BPS + maxPremiumBps);
        if (stableIn > max) revert PriceAboveLimit(stableIn, max);
        uint256 own = IERC20(stable).balanceOf(address(this));
        if (own < stableIn) AAVE.withdraw(stable, stableIn - own, address(this));

        uint256 got = _swapVia(router, stable, stableIn, WETH, swapData);
        if (got < amount + premium) revert PriceBelowLimit(got, amount + premium);
        _flashOut = stableIn;
        return true; // Aave 從這裡拉走 amount + premium 的 WETH（建構時已經授權）
    }

    // ───────────────────────────── 資金 ─────────────────────────────

    /// @notice 從 owner 錢包轉穩定幣進來當初始抵押（要先 approve 給這個合約）
    function deposit(address stable, uint256 amount) external onlyOwner {
        IERC20(stable).safeTransferFrom(msg.sender, address(this), amount);
        _supply(stable, amount);
    }

    /// @notice 切換某個資產在 Aave 是否算抵押。資產 LTV = 0 時存進去的不會自動算抵押，LTV 恢復後要手動開
    function setCollateral(address asset, bool enabled) external onlyOwner {
        AAVE.setUserUseReserveAsCollateral(asset, enabled);
    }

    /// @notice 從 Aave 提出抵押品；amount = type(uint256).max 表示全部
    function withdraw(address asset, uint256 amount, address to) external onlyOwner returns (uint256) {
        return AAVE.withdraw(asset, amount, to);
    }

    /// @notice 用 owner 錢包裡的 WETH 直接還債（不經過 Uniswap）
    function repayFromOwner(uint256 amount) external onlyOwner returns (uint256 repaid) {
        IERC20(WETH).safeTransferFrom(msg.sender, address(this), amount);
        repaid = AAVE.repay(WETH, amount, VARIABLE_RATE, address(this));
        if (repaid < amount) IERC20(WETH).safeTransfer(msg.sender, amount - repaid);
    }

    function sweep(address token, address to) external onlyOwner {
        IERC20(token).safeTransfer(to, IERC20(token).balanceOf(address(this)));
    }

    // ───────────────────────────── 查詢 ─────────────────────────────

    function healthFactor() public view returns (uint256 hf) {
        (,,,,, hf) = AAVE.getUserAccountData(address(this));
    }

    function wethDebt() public view returns (uint256) {
        return IERC20(WETH_DEBT_TOKEN).balanceOf(address(this));
    }

    /// @notice Uniswap 價格比 Aave 預言機高多少（bps，可為負）
    function premiumBps(address uniPool) external view returns (int256) {
        (address stable, bool wethIsToken0,) = _checkPool(uniPool);
        (uint160 current,,,,,,) = IUniswapV3Pool(uniPool).slot0();
        uint256 fair = _oracleSqrtPriceX96(stable, wethIsToken0, 1, 1);
        // token0 是 WETH 時，sqrtPrice 越大 WETH 越貴；反之越小越貴
        (uint256 hi, uint256 lo) = wethIsToken0 ? (uint256(current), fair) : (fair, uint256(current));
        return int256(Math.mulDiv(Math.mulDiv(hi, hi, lo), BPS, lo)) - int256(BPS);
    }

    /// @notice 假設每顆 WETH 都剛好賣在「預言機價 × (1 + minEdgeBps)」（最差情況），
    ///         賣多少之後健康因子會剛好降到 targetHf。
    /// 健康因子 = Σ(抵押 × 清算門檻) / 債務；賣出 V（以預言機計價）會讓抵押多 V × (1 + edge)、債務多 V：
    ///   (C·lt + V·(1+edge)·ltS) / (D + V) ≥ H  ⇒  V ≤ (C·lt − H·D) / (H − (1+edge)·ltS)
    /// 分母 ≤ 0 時，賣再多健康因子也不會低於 H，回傳 type(uint256).max，交給價格上限和 maxWethIn 擋。
    function maxWethForHealthFactor(address stable, uint256 minEdgeBps, uint256 targetHf)
        public
        view
        returns (uint256)
    {
        (uint256 collateral, uint256 debt,, uint256 lt,,) = AAVE.getUserAccountData(address(this));
        uint256 stableLt = (AAVE.getConfiguration(stable) >> 16) & 0xFFFF;

        // 兩邊都放大成 1e18 × base currency
        uint256 headroom = collateral * lt * 1e14; // C·lt/1e4·1e18
        uint256 needed = targetHf * debt;
        if (headroom <= needed) return 0;

        uint256 gain = (BPS + minEdgeBps) * stableLt * 1e10; // (1+edge)·ltS·1e18
        if (targetHf <= gain) return type(uint256).max;

        uint256 valueBase = (headroom - needed) / (targetHf - gain);
        return Math.mulDiv(valueBase, 1e18, ORACLE.getAssetPrice(WETH));
    }

    /// @notice 用 stable 付款，現在最多買得起多少 WETH（close 會用它限制單筆）。
    /// 付款來源 = 合約手上的 stable + Aave 裡這種 stable 的抵押（但 Aave 這種 stable 的現金不夠時只算現金）；
    /// 用最差價格「預言機價 × (1 + maxPremiumBps)」加上池子手續費換算，再留 0.5% 緩衝
    function wethAffordable(address stable, uint24 fee, uint256 maxPremiumBps) public view returns (uint256) {
        address aToken = AAVE.getReserveData(stable).aTokenAddress;
        uint256 inAave = Math.min(IERC20(aToken).balanceOf(address(this)), IERC20(stable).balanceOf(aToken));
        uint256 budget = IERC20(stable).balanceOf(address(this)) + inAave;
        // weth = budget × (1 − fee) × 0.995 ÷ (預言機的 stable/WETH × (1 + maxPremium))
        uint256 num = budget * (1e6 - uint256(fee)) * 995;
        uint256 den = ORACLE.getAssetPrice(WETH) * 10 ** IERC20Metadata(stable).decimals() * (BPS + maxPremiumBps)
            * 1e6 * 1000;
        return Math.mulDiv(num, ORACLE.getAssetPrice(stable) * 1e18 * BPS, den);
    }

    // ───────────────────────────── 內部 ─────────────────────────────

    function _checkPool(address uniPool) internal view returns (address stable, bool wethIsToken0, uint24 fee) {
        IUniswapV3Pool p = IUniswapV3Pool(uniPool);
        address t0 = p.token0();
        address t1 = p.token1();
        if (t0 == WETH) (stable, wethIsToken0) = (t1, true);
        else if (t1 == WETH) (stable, wethIsToken0) = (t0, false);
        else revert BadPool();
        fee = p.fee();
        if (UNI_FACTORY.getPool(t0, t1, fee) != uniPool) revert BadPool();
    }

    function _swap(
        address uniPool,
        address stable,
        bool wethIsToken0,
        bool selling,
        int256 amountSpecified,
        uint160 limit
    ) internal returns (int256 wethDelta, int256 stableDelta) {
        // 賣 WETH：WETH 是 token0 就是 zeroForOne；買 WETH 反過來
        bool zeroForOne = selling == wethIsToken0;
        {
            (uint160 current,,,,,,) = IUniswapV3Pool(uniPool).slot0();
            // zeroForOne 會讓價格往下走，所以上限要在現價下面；反之在上面。不在就代表已經沒價差了
            if (zeroForOne ? limit >= current : limit <= current) revert NoEdge(current, limit);
        }
        bytes memory data = abi.encode(stable, wethIsToken0, selling);

        _activePool = uniPool;
        (int256 d0, int256 d1) = IUniswapV3Pool(uniPool).swap(address(this), zeroForOne, amountSpecified, limit, data);
        _activePool = address(0);
        (wethDelta, stableDelta) = wethIsToken0 ? (d0, d1) : (d1, d0);
    }

    /// @dev 「預言機價 × num / den」（穩定幣/WETH）換算成 Uniswap 的 sqrtPriceX96
    function _oracleSqrtPriceX96(address stable, bool wethIsToken0, uint256 num, uint256 den)
        internal
        view
        returns (uint160)
    {
        // 1 個最小單位 WETH 值多少最小單位穩定幣 = (pW / 10^dW) / (pS / 10^dS) = a / b
        uint256 a = ORACLE.getAssetPrice(WETH) * 10 ** IERC20Metadata(stable).decimals() * num;
        uint256 b = ORACLE.getAssetPrice(stable) * 1e18 * den;
        // Uniswap 的 price = token1 / token0
        (uint256 num, uint256 den) = wethIsToken0 ? (a, b) : (b, a);
        return uint160(Math.sqrt(Math.mulDiv(num, 1 << 192, den)));
    }

    /// @dev Aave flashLoan 模式 2：借 wethAmount 顆 WETH，回呼結束後直接變成這個合約的浮動利率債
    function _borrowViaFlash(uint256 wethAmount, bytes memory params) internal {
        address[] memory assets = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        uint256[] memory modes = new uint256[](1);
        (assets[0], amounts[0], modes[0]) = (WETH, wethAmount, VARIABLE_RATE);
        AAVE.flashLoan(address(this), assets, amounts, modes, address(this), params, 0);
    }

    /// @dev 只授權這一次要賣的量，呼叫完歸零；回傳實際多拿到多少 tokenOut（量餘額差）
    function _swapVia(address router, address tokenIn, uint256 amountIn, address tokenOut, bytes memory data)
        internal
        returns (uint256)
    {
        uint256 before = IERC20(tokenOut).balanceOf(address(this));
        IERC20(tokenIn).forceApprove(router, amountIn);
        (bool ok, bytes memory ret) = router.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        IERC20(tokenIn).forceApprove(router, 0);
        return IERC20(tokenOut).balanceOf(address(this)) - before;
    }

    /// @dev wethAmount 顆 WETH 照「預言機價 × factorBps / 1e4」值多少 stable（最小單位）
    function _stableFor(address stable, uint256 wethAmount, uint256 factorBps) internal view returns (uint256) {
        return Math.mulDiv(
            wethAmount * factorBps,
            ORACLE.getAssetPrice(WETH) * 10 ** IERC20Metadata(stable).decimals(),
            ORACLE.getAssetPrice(stable) * 1e18 * BPS
        );
    }

    function _supply(address stable, uint256 amount) internal {
        if (IERC20(stable).allowance(address(this), address(AAVE)) < amount) {
            IERC20(stable).forceApprove(address(AAVE), type(uint256).max);
        }
        AAVE.supply(stable, amount, address(this), 0);
    }
}
