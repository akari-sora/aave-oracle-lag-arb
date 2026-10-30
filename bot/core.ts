// 共用：鏈設定、地址、ABI、讀市場、送交易、機器人主迴圈、警示、出場。入口在 start.ts。
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  fallback,
  webSocket,
  formatUnits,
  http,
  parseAbi,
  parseGwei,
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type LocalAccount,
  type PublicClient,
} from "viem";
import { arbitrum, base, mainnet, optimism } from "viem/chains";
import { tr } from "./i18n.ts";

// bot/.env 有的話先讀進來（已經在環境變數裡的不會被蓋掉）
try {
  process.loadEnvFile(fileURLToPath(new URL(".env", import.meta.url)));
} catch {}

const env = (k: string, d: string) => process.env[k] || d;
const wad = (k: string, d: string) => BigInt(Math.round(Number(env(k, d)) * 1e6)) * 10n ** 12n;

export const CFG = {
  openPremiumBps: BigInt(env("OPEN_PREMIUM_BPS", "300")),
  minEdgeBps: BigInt(env("MIN_EDGE_BPS", "50")),
  targetHf: wad("TARGET_HF", "1.3"),
  maxWethPerTx: wad("MAX_WETH_PER_TX", "0"),
  // 開倉規模是用最差成交價估的，開完 HF 通常比 TARGET_HF 高，下個區塊還能再加碼；加碼量小於這個值就不送
  minWethPerTx: wad("MIN_WETH_PER_TX", "0.5"),
  // 溢價要連續這麼多秒都在門檻以上才開倉，過濾單筆大單造成、下個區塊就被套平的瞬間跳動
  confirmSeconds: Number(env("CONFIRM_SECONDS", "15")),
  closePremiumBps: BigInt(env("CLOSE_PREMIUM_BPS", "30")),
  // 緊急降槓桿買回到健康因子回到這個值就停（不再一口氣全平）
  emergencyTargetHf: wad("EMERGENCY_TARGET_HF", env("TARGET_HF", "1.3")),
  // 只平倉、不開新倉、不存本金（trader.sh exit 失敗後用這個模式保護部位）
  closeOnly: env("CLOSE_ONLY", "") === "1",
  // 池子裡的 WETH 少於這個量就當成死池：不在那裡開倉，也不會因為它顯示溢價就一直抱倉
  minPoolWeth: wad("MIN_POOL_WETH", "5"),
  // 連續這麼多次動作失敗（模擬或送出）就發 action_failing 警示
  actionFailAlert: Number(env("ACTION_FAIL_ALERT", "5")),
  emergencyHf: wad("EMERGENCY_HF", "1.1"),
  emergencyMaxPremiumBps: BigInt(env("EMERGENCY_MAX_PREMIUM_BPS", "1000")),
  exitMaxPremiumBps: BigInt(env("EXIT_MAX_PREMIUM_BPS", "300")),
  priorityFeeGwei: env("PRIORITY_FEE_GWEI", ""),
  gasLimitMult: Number(env("GAS_LIMIT_MULT", "1.25")), // 估完到上鏈之間價格會動，flash swap 可能多跨幾個 tick
  maxFeeBaseMult: BigInt(env("MAX_FEE_BASE_MULT", "2")), // maxFeePerGas = base fee × 這個 + 小費；事件期間 base fee 漲得快
  pollMs: Number(env("POLL_MS", "3000")),
  logMs: Number(env("LOG_MS", "30000")), // 沒事的時候每條鏈多久印一行
  minTickMs: Number(env("MIN_TICK_MS", "500")), // 新區塊來得很快（Arbitrum 每秒 4 個）時，兩次判斷至少隔這麼久
  // 聚合器：kyber（預設）或 off。開倉先問聚合器（能賣到 Uniswap V3／V4、Aerodrome、Curve、做市商），不夠好才用單一池子
  aggregator: env("AGGREGATOR", "kyber"),
  aggSlippageBps: Number(env("AGG_SLIPPAGE_BPS", "100")), // 給聚合器的滑價容忍；真正的價格保護是合約裡的預言機下限
  // 有變化才 POST，格式見 README「Alerts」一節
  alertWebhookUrl: env("ALERT_WEBHOOK_URL", ""),
  alertWebhookHeader: env("ALERT_WEBHOOK_HEADER", ""), // 例：Authorization: Bearer xxx
};

/// TARGET_HF 低於「清算門檻 ÷ LTV」（USDC 約 0.78 ÷ 0.75 = 1.04）時，Aave 借款會被 LTV 擋下，開倉永遠失敗
export function checkConfig() {
  const hf = formatUnits(CFG.targetHf, 18);
  if (CFG.targetHf < 105n * 10n ** 16n) throw new Error(tr(`TARGET_HF 至少要 1.05（現在 ${hf}）`, `TARGET_HF must be at least 1.05 (now ${hf})`));
  if (CFG.emergencyHf >= CFG.targetHf) throw new Error(tr("EMERGENCY_HF 要比 TARGET_HF 低", "EMERGENCY_HF must be lower than TARGET_HF"));
  if (CFG.emergencyTargetHf <= CFG.emergencyHf) {
    throw new Error(
      tr(
        "EMERGENCY_TARGET_HF 要比 EMERGENCY_HF 高（不然降槓桿永遠到不了目標）",
        "EMERGENCY_TARGET_HF must be higher than EMERGENCY_HF (otherwise deleveraging never reaches the target)",
      ),
    );
  }
}

// ───────────────────────────── 鏈 ─────────────────────────────
// 地址 2026-10-30 從鏈上核對過：Aave PoolAddressesProvider → getPool／getReserveData，Uniswap V3 factory → getPool。
// 穩定幣只列 Aave 有開放當抵押、而且 Uniswap V3 有 WETH 池的。

export type ChainKey = "mainnet" | "arbitrum" | "base" | "optimism";
export type ChainCfg = {
  key: ChainKey;
  name: string;
  chain: Chain;
  rpcUrl: string; // 第一個，顯示用
  rpcUrls: string[]; // 讀資料用，依序備援
  wsUrl?: string; // 訂閱新區塊用；沒有就只靠輪詢
  sendRpcUrl: string;
  aaveProvider: Address;
  uniFactory: Address;
  weth: Address;
  stables: Record<string, Address>;
  // Aerodrome／Velodrome Slipstream（Uniswap V3 的分支）：只拿來看價差，交易走聚合器
  clFactories?: { name: string; address: Address }[];
};

const CHAIN_DEFAULTS: Omit<ChainCfg, "rpcUrl" | "rpcUrls" | "wsUrl" | "sendRpcUrl">[] = [
  {
    key: "mainnet",
    name: "Ethereum",
    chain: mainnet,
    aaveProvider: "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e",
    uniFactory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    stables: { USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
  },
  {
    key: "arbitrum",
    name: "Arbitrum",
    chain: arbitrum,
    aaveProvider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
    uniFactory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    stables: { USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", USDT: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" },
  },
  {
    key: "base",
    name: "Base",
    chain: base,
    aaveProvider: "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D",
    uniFactory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    weth: "0x4200000000000000000000000000000000000006",
    stables: { USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, // Aave 在 Base 沒有 USDT
    clFactories: [{ name: "Aero", address: "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A" }],
  },
  {
    key: "optimism",
    name: "Optimism",
    chain: optimism,
    aaveProvider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
    uniFactory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    weth: "0x4200000000000000000000000000000000000006",
    stables: { USDC: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", USDT: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58" },
    clFactories: [
      { name: "Velo", address: "0xCc0bDDB707055e04e497aB22a59c2aF4391cd12F" },
      { name: "Aero", address: "0xfeaB42D90055db3a0616249f76B6002D72266778" },
    ],
  },
];

// 每條鏈兩個公開 RPC，第一個掛了或被限流就換第二個（viem fallback）
const DEFAULT_RPC: Record<ChainKey, string[]> = {
  mainnet: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"],
  arbitrum: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com"],
  base: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"],
  optimism: ["https://mainnet.optimism.io", "https://optimism-rpc.publicnode.com"],
};
// 新區塊一出來就通知（eth_subscribe newHeads），比每 3 秒輪詢快；2026-10-30 四條都測過能訂閱
const DEFAULT_WS: Record<ChainKey, string> = {
  mainnet: "wss://ethereum-rpc.publicnode.com",
  arbitrum: "wss://arbitrum-one-rpc.publicnode.com",
  base: "wss://base-rpc.publicnode.com",
  optimism: "wss://optimism-rpc.publicnode.com",
};
// 主網用私有交易池：不會被搶先或夾，會失敗的交易也不會上鏈、不扣 gas。L2 沒有公開的交易池可以夾，直接送
const DEFAULT_SEND_RPC: Partial<Record<ChainKey, string>> = { mainnet: "https://rpc.flashbots.net/fast" };

/// CHAINS=mainnet,arbitrum 只跑這幾條。換 RPC：RPC_URL_<鏈>（一個）或 RPC_URLS_<鏈>（逗號分隔，依序備援）；SEND_RPC_URL_<鏈> 送交易用
export const CHAINS: ChainCfg[] = CHAIN_DEFAULTS.filter((c) => env("CHAINS", "mainnet,arbitrum,base,optimism").split(",").includes(c.key)).map(
  (c) => {
    const K = c.key.toUpperCase();
    const list = process.env[`RPC_URLS_${K}`]?.split(",").map((u) => u.trim()).filter(Boolean);
    const single = process.env[`RPC_URL_${K}`];
    const rpcUrls = list?.length ? list : single ? [single] : DEFAULT_RPC[c.key];
    // WS_URL_<鏈>=off 關掉訂閱；換了讀資料的 RPC 卻沒給 WS 時也不用預設的（例如指向本機 fork 時）
    const ws = process.env[`WS_URL_${K}`] ?? (list?.length || single ? undefined : DEFAULT_WS[c.key]);
    return {
      ...c,
      rpcUrl: rpcUrls[0],
      rpcUrls,
      wsUrl: ws && ws !== "off" ? ws : undefined,
      sendRpcUrl: env(`SEND_RPC_URL_${K}`, DEFAULT_SEND_RPC[c.key] ?? rpcUrls[0]),
    };
  },
);

const FEES = [100, 500, 3000];
const CL_TICK_SPACINGS = [1, 10, 50, 100, 200, 2000];
const MAX_UINT = 2n ** 256n - 1n;

const providerAbi = parseAbi(["function getPool() view returns (address)", "function getPriceOracle() view returns (address)"]);
const aaveAbi = parseAbi([
  "function getConfiguration(address) view returns (uint256)",
  "function getVirtualUnderlyingBalance(address) view returns (uint128)",
  "function getUserAccountData(address) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
  "function getReserveData(address) view returns ((uint256,uint128,uint128,uint128,uint128,uint128,uint40,uint16,address aToken,address,address,address,uint128,uint128,uint128))",
]);
const oracleAbi = parseAbi(["function getAssetPrice(address) view returns (uint256)"]);
export const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256)",
]);
const factoryAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const clFactoryAbi = parseAbi(["function getPool(address,address,int24) view returns (address)"]);
// Slipstream 的 slot0 只有 6 個回傳（沒有 feeProtocol），用 Uniswap 的 ABI 會解碼失敗
const clPoolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24, uint16, uint16, uint16, bool)",
  "function fee() view returns (uint24)",
]);
const poolAbi = parseAbi([
  "function token0() view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24, uint16, uint16, uint16, uint8, bool)",
]);
export const arbAbi = parseAbi([
  "function owner() view returns (address)",
  "function healthFactor() view returns (uint256)",
  "function wethDebt() view returns (uint256)",
  "function open(address uniPool, uint256 minEdgeBps, uint256 sizingEdgeBps, uint256 targetHf, uint256 maxWethIn) returns (uint256 wethSold, uint256 stableReceived)",
  "function wethAffordable(address stable, uint24 fee, uint256 maxPremiumBps) view returns (uint256)",
  "function maxWethForHealthFactor(address stable, uint256 minEdgeBps, uint256 targetHf) view returns (uint256)",
  "function routers(address) view returns (bool)",
  "function setRouter(address router, bool allowed)",
  "function openVia(address stable, uint256 wethAmount, uint256 minEdgeBps, uint256 targetHf, address router, bytes swapData) returns (uint256 stableReceived)",
  "function closeVia(address stable, uint256 wethAmount, uint256 stableIn, uint256 maxPremiumBps, address router, bytes swapData) returns (uint256 wethRepaid)",
  "error RouterNotAllowed()",
  "error UnauthorizedFlashLoan()",
  "error PriceBelowLimit(uint256 got, uint256 min)",
  "error PriceAboveLimit(uint256 paid, uint256 max)",
  "function close(address uniPool, uint256 maxPremiumBps, uint256 maxWethOut) returns (uint256 wethBought, uint256 stablePaid)",
  "function deposit(address stable, uint256 amount)",
  "function withdraw(address asset, uint256 amount, address to) returns (uint256)",
  "function sweep(address token, address to)",
  "error NoEdge(uint160 sqrtPriceX96, uint160 sqrtPriceLimitX96)",
  "error HealthFactorTooLow(uint256 healthFactor)",
  "error NothingToDo()",
  "error NotOwner()",
  "error BadPool()",
]);

/// kind：uni = Uniswap V3（合約能直接 flash swap）；cl = Aerodrome／Velodrome（只看價差，交易走聚合器）
export type Pool = { address: Address; kind: "uni" | "cl"; name: string; fee: number; stable: Address; stableName: string; stableDecimals: number; wethIsToken0: boolean };
export type Quote = Pool & { premiumBps: bigint; poolWeth: bigint };
export type Market = {
  block: bigint;
  wethPrice: bigint;
  wethFrozen: boolean;
  wethLiquidity: bigint;
  wethBorrowable: bigint; // Aave 現在最多還能借出多少 WETH：可用流動性和 borrow cap 剩餘額度取小的
  stableOk: Map<Address, boolean>; // 沒凍結、沒暫停、LTV > 0，存得進去也算得上抵押
  stableRoom: Map<Address, bigint>; // 這種穩定幣在 Aave 還能存多少（supply cap 剩餘，最小單位；沒上限就是很大的數）
  stablePrice: Map<Address, bigint>;
  quotes: Quote[]; // 溢價由高到低
};
export type Position = {
  debt: bigint;
  hf: bigint;
  collateral: Map<Address, bigint>;
  collateralBase: bigint; // Aave 的 base currency（USD，8 位小數）
  debtBase: bigint;
  lt: bigint; // 加權清算門檻（bps）
};

const Q96 = 2n ** 96n;
export const frozen = (cfg: bigint) => ((cfg >> 57n) & 1n) === 1n;
const usable = (cfg: bigint) => ((cfg >> 56n) & 1n) === 1n && !frozen(cfg) && ((cfg >> 60n) & 1n) === 0n; // active、沒凍結、沒暫停
const ltv = (cfg: bigint) => cfg & 0xffffn;
export const pct = (bps: bigint) => `${bps >= 0n ? "+" : ""}${(Number(bps) / 100).toFixed(2)}%`;
export const fmtHf = (x: bigint) => (x > 10n ** 30n ? "∞" : Number(formatUnits(x, 18)).toFixed(3));
export const ts = () => new Date().toISOString().slice(11, 19);
/// 錯誤訊息一行：viem 的 shortMessage，合約的自訂錯誤要把名字接上（不然只看得到 "reverted."）
export const errMsg = (e: unknown) => {
  const base = ((e as { shortMessage?: string }).shortMessage ?? (e as Error).message.split("\n")[0]).replace(/\s*\n\s*/g, " ");
  for (let c: any = e; c; c = c.cause) {
    if (c.data?.errorName) return tr(`${base}（${c.data.errorName}）`, `${base} (${c.data.errorName})`);
  }
  return base;
};

// ───────────────────────────── 讀市場 ─────────────────────────────

export type Ctx = {
  chain: ChainCfg;
  client: PublicClient;
  aavePool: Address;
  oracle: Address;
  wethDebtToken: Address;
  pools: Pool[];
  aTokens: Map<Address, Address>;
  decimals: Map<Address, number>;
};

export const transportFor = (c: ChainCfg) => fallback(c.rpcUrls.map((u) => http(u, { timeout: 30_000 })), { retryCount: 2 });
export const clientFor = (c: ChainCfg) => createPublicClient({ chain: c.chain, transport: transportFor(c) }) as PublicClient;
export const stableName = (ctx: Ctx, a: Address) =>
  Object.entries(ctx.chain.stables).find(([, v]) => v.toLowerCase() === a.toLowerCase())?.[0] ?? a;

export async function loadCtx(chain: ChainCfg): Promise<Ctx> {
  const client = clientFor(chain);
  const chainId = await client.getChainId();
  if (chainId !== chain.chain.id) {
    throw new Error(tr(`${chain.name} 的 RPC 回 chain ${chainId}，應該是 ${chain.chain.id}`, `${chain.name} RPC returned chain ${chainId}, expected ${chain.chain.id}`));
  }
  const [aavePool, oracle] = await Promise.all([
    client.readContract({ address: chain.aaveProvider, abi: providerAbi, functionName: "getPool" }),
    client.readContract({ address: chain.aaveProvider, abi: providerAbi, functionName: "getPriceOracle" }),
  ]);
  const wethData = await client.readContract({ address: aavePool, abi: aaveAbi, functionName: "getReserveData", args: [chain.weth] });
  const decimals = new Map<Address, number>();
  const aTokens = new Map<Address, Address>();
  const pools: Pool[] = [];
  for (const [name, stable] of Object.entries(chain.stables)) {
    decimals.set(stable, await client.readContract({ address: stable, abi: erc20Abi, functionName: "decimals" }));
    const data = await client.readContract({ address: aavePool, abi: aaveAbi, functionName: "getReserveData", args: [stable] });
    aTokens.set(stable, data[8]);
    for (const fee of FEES) {
      const address = await client.readContract({ address: chain.uniFactory, abi: factoryAbi, functionName: "getPool", args: [chain.weth, stable, fee] });
      if (/^0x0+$/.test(address)) continue;
      const token0 = await client.readContract({ address, abi: poolAbi, functionName: "token0" });
      pools.push({
        address,
        kind: "uni",
        name: `${name} ${fee / 1e4}%`,
        fee,
        stable,
        stableName: name,
        stableDecimals: decimals.get(stable)!,
        wethIsToken0: token0.toLowerCase() === chain.weth.toLowerCase(),
      });
    }
  }
  for (const f of chain.clFactories ?? []) {
    for (const [name, stable] of Object.entries(chain.stables)) {
      for (const ts of CL_TICK_SPACINGS) {
        const address = await client.readContract({ address: f.address, abi: clFactoryAbi, functionName: "getPool", args: [chain.weth, stable, ts] });
        if (/^0x0+$/.test(address)) continue;
        const [token0, fee] = await Promise.all([
          client.readContract({ address, abi: poolAbi, functionName: "token0" }),
          client.readContract({ address, abi: clPoolAbi, functionName: "fee" }),
        ]);
        pools.push({
          address,
          kind: "cl",
          name: `${name} ${f.name}${ts}`,
          fee,
          stable,
          stableName: name,
          stableDecimals: decimals.get(stable)!,
          wethIsToken0: token0.toLowerCase() === chain.weth.toLowerCase(),
        });
      }
    }
  }
  return { chain, client, aavePool, oracle, wethDebtToken: wethData[10], pools, aTokens, decimals };
}

// 跟合約 premiumBps() 同一套算法：Uniswap 的 穩定幣/WETH ÷ 預言機的 穩定幣/WETH − 1
function premiumBps(p: Pool, sqrtPriceX96: bigint, wethPrice: bigint, stablePrice: bigint): bigint {
  const a = wethPrice * 10n ** BigInt(p.stableDecimals);
  const b = stablePrice * 10n ** 18n;
  const s2 = sqrtPriceX96 * sqrtPriceX96; // sqrt² / 2^192 = token1/token0
  return p.wethIsToken0 ? (s2 * b * 10_000n) / (a * Q96 * Q96) - 10_000n : (Q96 * Q96 * b * 10_000n) / (s2 * a) - 10_000n;
}

export async function readMarket(ctx: Ctx, block?: bigint): Promise<Market> {
  const { client, chain } = ctx;
  const stables = Object.values(chain.stables);
  const [blockNumber, reads] = await Promise.all([
    block ?? client.getBlockNumber(),
    client.multicall({
      allowFailure: false,
      contracts: [
        { address: ctx.oracle, abi: oracleAbi, functionName: "getAssetPrice", args: [chain.weth] },
        ...stables.map((s) => ({ address: ctx.oracle, abi: oracleAbi, functionName: "getAssetPrice", args: [s] }) as const),
        { address: ctx.aavePool, abi: aaveAbi, functionName: "getConfiguration", args: [chain.weth] },
        ...stables.map((s) => ({ address: ctx.aavePool, abi: aaveAbi, functionName: "getConfiguration", args: [s] }) as const),
        { address: ctx.aavePool, abi: aaveAbi, functionName: "getVirtualUnderlyingBalance", args: [chain.weth] },
        { address: ctx.wethDebtToken, abi: erc20Abi, functionName: "totalSupply" },
        ...stables.map((s) => ({ address: ctx.aTokens.get(s)!, abi: erc20Abi, functionName: "totalSupply" }) as const),
        ...ctx.pools.map((p) => (p.kind === "cl" ? ({ address: p.address, abi: clPoolAbi, functionName: "slot0" } as const) : ({ address: p.address, abi: poolAbi, functionName: "slot0" } as const))),
        ...ctx.pools.map((p) => ({ address: chain.weth, abi: erc20Abi, functionName: "balanceOf", args: [p.address] }) as const),
      ],
    }),
  ]);
  let i = 0;
  const wethPrice = reads[i++] as bigint;
  const stablePrice = new Map(stables.map((s) => [s, reads[i++] as bigint]));
  const wethCfg = reads[i++] as bigint;
  const stableCfg = new Map(stables.map((s) => [s, reads[i++] as bigint]));
  const stableOk = new Map(stables.map((s) => [s, usable(stableCfg.get(s)!) && ltv(stableCfg.get(s)!) > 0n]));
  const wethLiquidity = reads[i++] as bigint;
  const wethDebtTotal = reads[i++] as bigint;
  const stableRoom = new Map(
    stables.map((s) => {
      const supplied = reads[i++] as bigint;
      const cap = ((stableCfg.get(s)! >> 116n) & ((1n << 36n) - 1n)) * 10n ** BigInt(ctx.decimals.get(s)!); // 0 = 沒有上限
      return [s, cap === 0n ? MAX_UINT : cap > supplied ? cap - supplied : 0n];
    }),
  );
  const borrowCap = ((wethCfg >> 80n) & ((1n << 36n) - 1n)) * 10n ** 18n; // 0 = 沒有上限
  const capRoom = borrowCap === 0n ? wethLiquidity : borrowCap > wethDebtTotal ? borrowCap - wethDebtTotal : 0n;
  const slot0s = ctx.pools.map(() => reads[i++] as readonly [bigint, ...unknown[]]);
  const quotes = ctx.pools.map((p, j) => ({
    ...p,
    premiumBps: premiumBps(p, slot0s[j][0], wethPrice, stablePrice.get(p.stable)!),
    poolWeth: reads[i++] as bigint,
  }));
  quotes.sort((a, b) => Number(b.premiumBps - a.premiumBps));
  const wethBorrowable = wethLiquidity < capRoom ? wethLiquidity : capRoom;
  return { block: blockNumber, wethPrice, wethFrozen: !usable(wethCfg), wethLiquidity, wethBorrowable, stableOk, stableRoom, stablePrice, quotes };
}

export async function readPosition(ctx: Ctx, arb: Address): Promise<Position> {
  const stables = Object.values(ctx.chain.stables);
  // 不同 ABI 混在一個 multicall 裡，型別推不出來；結果照順序自己轉
  const contracts: readonly unknown[] = [
    { address: arb, abi: arbAbi, functionName: "wethDebt" },
    { address: arb, abi: arbAbi, functionName: "healthFactor" },
    { address: ctx.aavePool, abi: aaveAbi, functionName: "getUserAccountData", args: [arb] },
    ...stables.map((s) => ({ address: ctx.aTokens.get(s)!, abi: erc20Abi, functionName: "balanceOf", args: [arb] })),
  ];
  const reads = (await ctx.client.multicall({ allowFailure: false, contracts: contracts as never })) as unknown[];
  const acct = reads[2] as readonly bigint[];
  return {
    debt: reads[0] as bigint,
    hf: reads[1] as bigint,
    collateral: new Map(stables.map((s, j) => [s, reads[3 + j] as bigint])),
    collateralBase: acct[0],
    debtBase: acct[1],
    lt: acct[3],
  };
}

/// 池子裡至少有 MIN_POOL_WETH 顆 WETH 的才算數：幾乎空的池子價格可以亂跳，不能拿來判斷或發警示
export const livePools = (m: Market) => m.quotes.filter((q) => q.poolWeth >= CFG.minPoolWeth);

export function describe(ctx: Ctx, m: Market, p?: Position) {
  const pools = livePools(m).map((q) => `${q.name} ${pct(q.premiumBps)}`).join(" | ");
  const borrowable = Number(formatUnits(m.wethBorrowable, 18)).toFixed(0);
  const aave = m.wethFrozen ? tr("Aave 凍結中", "Aave frozen") : tr(`WETH 可借 ${borrowable}`, `WETH borrowable ${borrowable}`);
  let pos = "";
  if (p) {
    const coll = [...p.collateral]
      .filter(([, v]) => v > 0n)
      .map(([s, v]) => `${Number(formatUnits(v, ctx.decimals.get(s)!)).toFixed(0)} ${stableName(ctx, s)}`)
      .join("+");
    const debt = Number(formatUnits(p.debt, 18)).toFixed(3);
    pos = tr(` | 抵押 ${coll || "0"} 債 ${debt} WETH HF ${fmtHf(p.hf)}`, ` | collateral ${coll || "0"} debt ${debt} WETH HF ${fmtHf(p.hf)}`);
  }
  const price = (Number(m.wethPrice) / 1e8).toFixed(2);
  return tr(`${ts()} [${ctx.chain.name}] #${m.block} 預言機 $${price} | ${pools} | ${aave}${pos}`, `${ts()} [${ctx.chain.name}] #${m.block} oracle $${price} | ${pools} | ${aave}${pos}`);
}

// ───────────────────────────── 送交易 ─────────────────────────────

export class Sender {
  readonly account: LocalAccount;
  private ctx: Ctx;
  private wallet;
  private sendWallet;

  constructor(account: LocalAccount, ctx: Ctx) {
    this.account = account;
    this.ctx = ctx;
    // 用讀資料的 RPC 估 gas、拿 nonce、簽名；用 SEND_RPC_URL 送出去
    this.wallet = createWalletClient({ account, chain: ctx.chain.chain, transport: transportFor(ctx.chain) });
    this.sendWallet = createWalletClient({ chain: ctx.chain.chain, transport: http(ctx.chain.sendRpcUrl, { timeout: 60_000 }) });
  }

  async send(to: Address | undefined, data: Hex): Promise<{ hash: Hex; nonce: number }> {
    const [block, tip] = await Promise.all([
      this.ctx.client.getBlock(),
      CFG.priorityFeeGwei ? parseGwei(CFG.priorityFeeGwei) : this.ctx.client.estimateMaxPriorityFeePerGas(),
    ]);
    const request = await this.wallet.prepareTransactionRequest({
      to,
      data,
      maxPriorityFeePerGas: tip,
      maxFeePerGas: block.baseFeePerGas! * CFG.maxFeeBaseMult + tip,
    });
    request.gas = (request.gas! * BigInt(Math.round(CFG.gasLimitMult * 100))) / 100n;
    const serializedTransaction = await this.wallet.signTransaction(request);
    const hash = await this.sendWallet.sendRawTransaction({ serializedTransaction });
    return { hash, nonce: request.nonce! };
  }

  /// CLI 用：送出並等上鏈。私有交易池不會把失敗的交易上鏈，等不到就當作沒送成
  async sendAndWait(label: string, to: Address | undefined, data: Hex) {
    const { hash } = await this.send(to, data);
    console.log(tr(`  [${this.ctx.chain.name}] ${label}：送出 ${hash}`, `  [${this.ctx.chain.name}] ${label}: sent ${hash}`));
    try {
      const r = await this.ctx.client.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (r.status !== "success") throw new Error(tr(`${label} 交易失敗（${hash}）`, `${label} transaction failed (${hash})`));
      return r;
    } catch (e) {
      if ((e as Error).name === "WaitForTransactionReceiptTimeoutError") {
        throw new Error(
          tr(
            `${label} 三分鐘內沒上鏈（${hash}）。用私有交易池時，會失敗的交易會被直接丟掉；可以稍後再跑一次`,
            `${label} not mined within 3 minutes (${hash}). A private mempool drops transactions that would fail; you can run it again later`,
          ),
        );
      }
      throw e;
    }
  }

  async call(label: string, arb: Address, functionName: string, args: readonly unknown[]) {
    const data = encodeFunctionData({ abi: arbAbi as Abi, functionName, args });
    return this.sendAndWait(label, arb, data);
  }
}

async function simulate(ctx: Ctx, arb: Address, from: Address, functionName: "open" | "close" | "openVia" | "closeVia", args: readonly unknown[]) {
  const { result } = await ctx.client.simulateContract({ address: arb, abi: arbAbi, functionName, args: args as never, account: from });
  return result as readonly [bigint, bigint];
}

// ───────────────────────────── 聚合器（KyberSwap） ─────────────────────────────
// 免 API key。四條鏈同一個 router（2026-10-30 查過）。只在有機會或要平倉時才問，免費額度有限

export const KYBER_ROUTER: Address = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";
const KYBER_CHAIN: Record<ChainKey, string> = { mainnet: "ethereum", arbitrum: "arbitrum", base: "base", optimism: "optimism" };
export const aggregatorOn = () => CFG.aggregator === "kyber";

export type AggRoute = { amountOut: bigint; router: Address; data: Hex };

/// 被限流（HTTP 429）的鏈，30 秒內不再問，改走單一池子
const kyberThrottledUntil = new Map<ChainKey, number>();

/// 問 KyberSwap：賣 amountIn 的 tokenIn 換 tokenOut，收款人 recipient。拿到的是可以直接送的 calldata。
/// deadline 照我們給的寫進 calldata（2026-10-30 驗證過 10 分鐘、1 小時都照給）
export async function kyberRoute(k: ChainKey, tokenIn: Address, tokenOut: Address, amountIn: bigint, recipient: Address): Promise<AggRoute | undefined> {
  if (Date.now() < (kyberThrottledUntil.get(k) ?? 0)) return undefined;
  const base = `https://aggregator-api.kyberswap.com/${KYBER_CHAIN[k]}/api/v1`;
  const headers = { "x-client-id": "aave-u-eth", "content-type": "application/json" };
  const json = async (r: Response) => {
    if (r.status === 429) kyberThrottledUntil.set(k, Date.now() + 30_000);
    return r.json();
  };
  try {
    const q = await fetch(`${base}/routes?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}`, { headers, signal: AbortSignal.timeout(5_000) }).then(json);
    if (q.code !== 0 || !q.data?.routeSummary) return undefined;
    const b = await fetch(`${base}/route/build`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(5_000),
      body: JSON.stringify({
        routeSummary: q.data.routeSummary,
        sender: recipient,
        recipient,
        slippageTolerance: CFG.aggSlippageBps,
        deadline: Math.floor(Date.now() / 1000) + 600, // 主網走私有交易池可能要等幾個區塊，給 10 分鐘
        source: "aave-u-eth",
      }),
    }).then(json);
    if (b.code !== 0 || !b.data?.data) return undefined;
    if (String(b.data.routerAddress).toLowerCase() !== KYBER_ROUTER.toLowerCase()) return undefined; // 不是白名單裡那個就不用
    return { amountOut: BigInt(b.data.amountOut), router: KYBER_ROUTER, data: b.data.data as Hex };
  } catch {
    return undefined;
  }
}

/// wethAmount 顆 WETH 照預言機價 × factorBps / 1e4 值多少 stable（最小單位）——跟合約的 _stableFor 一樣
export const stableFor = (m: Market, stable: Address, decimals: number, wethAmount: bigint, factorBps: bigint) =>
  (wethAmount * factorBps * m.wethPrice * 10n ** BigInt(decimals)) / (m.stablePrice.get(stable)! * 10n ** 18n * 10_000n);

/// 用聚合器平倉的參數：挑抵押最多的穩定幣，買回 min(債, maxWethOut, 抵押付得起的量)，
/// stableIn 先照預言機價多給一點，報價換回的 WETH 不夠「買回量 + flash loan 手續費」就加到 maxPremium 上限再問一次
export async function planAggClose(ctx: Ctx, m: Market, p: Position, arb: Address, maxPremium: bigint, maxWethOut = 0n) {
  const value = (s: Address, v: bigint) => (v * m.stablePrice.get(s)! * 10n ** 18n) / 10n ** BigInt(ctx.decimals.get(s)!);
  const stables = [...p.collateral].filter(([, v]) => v > 0n).sort((a, b) => (value(b[0], b[1]) > value(a[0], a[1]) ? 1 : -1));
  for (const [stable, coll] of stables) {
    const dec = ctx.decimals.get(stable)!;
    let w = maxWethOut > 0n && maxWethOut < p.debt ? maxWethOut : p.debt;
    const collW = (coll * m.stablePrice.get(stable)! * 10n ** 18n * 10_000n * 98n) / (m.wethPrice * 10n ** BigInt(dec) * (10_000n + maxPremium) * 100n);
    if (w > collW) w = collW;
    if (w < CFG.minWethPerTx && w < p.debt) continue;
    const need = (w * 10_005n) / 10_000n; // + flash loan 手續費 0.05%
    for (const bump of [maxPremium < 50n ? maxPremium : 50n, maxPremium]) {
      const stableIn = stableFor(m, stable, dec, need, 10_000n + bump);
      const route = await kyberRoute(ctx.chain.key, stable, ctx.chain.weth, stableIn, arb);
      if (route && route.amountOut >= need) return { stable, w, stableIn, route };
    }
  }
  return undefined;
}

// ───────────────────────────── 機器人 ─────────────────────────────

export type PendingDeposit = { token: Address; amount: bigint };

export type BotOptions = {
  ctx: Ctx;
  arb?: Address; // 沒有合約就只監控、推警示
  owner?: Address;
  sender?: Sender; // 沒有就只模擬
  pendingDeposits?: PendingDeposit[];
  onDeposited?: (token: Address) => void;
};

/// 這條鏈的 gas 低於這個值就發 gas_low（持倉中 gas 用完，緊急降槓桿就送不出去）
export const gasFloor = (k: ChainKey) => (k === "mainnet" ? 2n * 10n ** 16n : 2n * 10n ** 15n);
const MAINNET_FLASHBOTS = /flashbots\.net/;

/// 緊急降槓桿要買回多少 WETH，健康因子才會回到 H：
/// 買 W 顆、每顆付 Pb（預言機價 × (1+maxPremium) ÷ (1−0.3% 手續費)）、債少 W·Po：
///   (C·lt − W·Pb·lt) / (D − W·Po) ≥ H  ⇒  W ≥ (H·D − C·lt) / (H·Po − Pb·lt)
/// 分母 ≤ 0 表示用這個價格買回反而讓 HF 更低，只能全部平掉（回傳 0 = 不限）
export function emergencyBuyback(p: Position, wethPrice: bigint, maxPremiumBps: bigint, targetHf: bigint): bigint {
  const pb = (wethPrice * (10_000n + maxPremiumBps) * 1_000_000n) / (10_000n * 997_000n);
  const num = targetHf * p.debtBase - p.collateralBase * p.lt * 10n ** 14n; // 1e18 × base
  const den = targetHf * wethPrice - pb * p.lt * 10n ** 14n; // 1e18 × base / WETH
  if (num <= 0n) return 1n; // 已經夠了（不會發生在 HF < EMERGENCY_HF 時），象徵性買一點
  if (den <= 0n) return 0n;
  const w = (num * 10n ** 18n * 105n) / (den * 100n); // 多買 5%
  return w < p.debt ? w : 0n;
}

/// 每條鏈每個區塊依序判斷，前一條成立就不看後面：
///  0. 有還沒上鏈的交易 → 等（上鏈、nonce 被用掉、或私有交易池說丟掉了就放行）
///  1. 有待存的本金，而且 Aave 能存 → 存
///  2. 有債、HF < EMERGENCY_HF → 買回到 HF 回到 EMERGENCY_TARGET_HF（不一口氣全平）
///  3. 有「能用的」池子溢價 ≥ OPEN_PREMIUM_BPS 持續 CONFIRM_SECONDS → 依溢價高低逐一試開倉／加碼；價差還在就抱著
///     能用 = 穩定幣能存（沒凍結、LTV > 0、supply cap 有空間）而且池子不是死池
///  4. 有債、某池溢價 ≤ CLOSE_PREMIUM_BPS → 從便宜的池子開始買回；合約一次只買付得起的量，下個區塊再換別的穩定幣
export async function runBot(o: BotOptions) {
  const { ctx } = o;
  const k = ctx.chain.key;
  const alerts = new Alerts(ctx);
  let lastBlock = 0n;
  let lastLog = 0;
  let premiumSince: number | undefined; // 能用的池子溢價從什麼時候開始一直在門檻以上
  let pending: { hash: Hex; nonce: number; label: string; block: bigint; token?: Address } | undefined;
  let actionFailures = 0;
  let gasLow = false;
  let busy = false;
  // 聚合器路徑要合約先把 router 加進白名單（setupChain 會做）；還沒加的話每分鐘再看一次，加好之前只走單一池子
  let aggReady = false;
  let aggCheckedAt = 0;
  const checkAgg = async () => {
    if (aggReady || !aggregatorOn() || !o.arb || Date.now() - aggCheckedAt < 60_000) return;
    aggCheckedAt = Date.now();
    aggReady = await ctx.client.readContract({ address: o.arb, abi: arbAbi, functionName: "routers", args: [KYBER_ROUTER] }).catch(() => false);
  };
  await checkAgg();
  const say = (s: string) => console.log(`  [${ctx.chain.name}] ${s}`);
  // label 是內部用的 key（pending.label === "存本金"、note 的 kind），印出來時才翻
  const tag = (label: string) => tr(label, ({ 開倉: "open", 平倉: "close", 緊急降槓桿: "deleverage", 存本金: "deposit" } as Record<string, string>)[label] ?? label);
  // 「凍結中不能開」「量太小不送」「模擬失敗」這類每個區塊都會成立的狀態，同一種每 LOG_MS 只印一次
  const lastNote = new Map<string, number>();
  const note = (kind: string, s: string) => {
    if (Date.now() - (lastNote.get(kind) ?? 0) < CFG.logMs) return;
    lastNote.set(kind, Date.now());
    say(s);
  };

  const send = async (label: string, data: Hex, token?: Address) => {
    const { hash, nonce } = await o.sender!.send(o.arb, data);
    pending = { hash, nonce, label, block: lastBlock, token };
    say(tr(`送出 ${hash}`, `sent ${hash}`));
  };

  const act = async (label: string, functionName: "open" | "close" | "openVia" | "closeVia", q: Quote, args: readonly unknown[]) => {
    try {
      const r = await simulate(ctx, o.arb!, o.owner!, functionName, args);
      // open/close 回傳 (WETH, stable)；openVia 回傳換到的 stable；closeVia 回傳還了多少 WETH
      const [weth, stable] =
        functionName === "openVia" ? [args[1] as bigint, r as unknown as bigint] : functionName === "closeVia" ? [r as unknown as bigint, args[2] as bigint] : r;
      const w = formatUnits(weth, 18);
      if (functionName === "open" && weth < CFG.minWethPerTx) {
        note(`dust:${q.address}`, tr(`[${label}] ${q.name} 只能再賣 ${w} WETH，低於 MIN_WETH_PER_TX，不送`, `[${tag(label)}] ${q.name} can only sell ${w} more WETH, below MIN_WETH_PER_TX, not sending`));
        return "skip";
      }
      const isOpen = functionName.startsWith("open");
      const isVia = functionName.endsWith("Via");
      const s = formatUnits(stable, q.stableDecimals);
      say(
        tr(
          `[${label}] ${isVia ? "經聚合器 " : ""}${q.name} ${pct(q.premiumBps)}：${isOpen ? "賣" : "買"} ${w} WETH，${isOpen ? "收" : "付"} ${s} ${q.stableName}`,
          `[${tag(label)}] ${isVia ? "via aggregator " : ""}${q.name} ${pct(q.premiumBps)}: ${isOpen ? "sell" : "buy"} ${w} WETH, ${isOpen ? "receive" : "pay"} ${s} ${q.stableName}`,
        ),
      );
      if (!o.sender) return "sent";
      await send(label, encodeFunctionData({ abi: arbAbi, functionName, args: args as never }));
      actionFailures = 0;
      return "sent";
    } catch (e) {
      const msg = errMsg(e);
      // 合約說「沒事可做」、「價格已經到上限沒空間」（買回把池子推到上限，要等別人把價格拉回來）不算失敗
      if (/NothingToDo|HealthFactorTooLow|NoEdge|PriceBelowLimit|PriceAboveLimit/.test(msg)) {
        const why = msg.match(/NothingToDo|HealthFactorTooLow|NoEdge|PriceBelowLimit|PriceAboveLimit/)![0];
        note(`skip:${label}:${functionName}:${q.address}`, tr(`[${label}] ${q.name} 先不做：${why}`, `[${tag(label)}] ${q.name} skipped for now: ${why}`));
        return "skip";
      }
      actionFailures++;
      note(`fail:${label}:${q.address}`, tr(`[${label}] ${q.name} 沒送：${msg}`, `[${tag(label)}] ${q.name} not sent: ${msg}`));
      return "fail";
    }
  };

  /// 經聚合器開倉：規模 = min(健康因子撐得住的量（用溢價的一半估）, openCap)，報價扣掉滑價後不到預言機下限就減半，最多試 3 次
  const aggOpen = async (m: Market, q: Quote) => {
    const half = q.premiumBps / 2n > CFG.minEdgeBps ? q.premiumBps / 2n : CFG.minEdgeBps;
    const hfCap = await ctx.client.readContract({ address: o.arb!, abi: arbAbi, functionName: "maxWethForHealthFactor", args: [q.stable, half, CFG.targetHf] });
    const cap = openCap(m, q);
    let w = hfCap < cap ? hfCap : cap;
    for (let i = 0; i < 3 && w >= CFG.minWethPerTx; i++, w /= 2n) {
      const route = await kyberRoute(k, ctx.chain.weth, q.stable, w, o.arb!);
      if (!route) {
        note("agg", tr("聚合器沒有回應，改用單一池子", "aggregator did not respond, falling back to single pools"));
        return "skip";
      }
      const floor = stableFor(m, q.stable, q.stableDecimals, w, 10_000n + CFG.minEdgeBps);
      if (route.amountOut < floor) continue; // 這個量賣不到預言機下限，少賣一點
      if ((await act("開倉", "openVia", q, [q.stable, w, CFG.minEdgeBps, CFG.targetHf, route.router, route.data])) === "sent") return "sent";
    }
    return "skip";
  };

  /// 經聚合器平倉（單一池子都平不了的時候用）
  const aggClose = async (m: Market, p: Position, maxPremium: bigint, label: string, maxWethOut = 0n) => {
    if (!aggReady) return false;
    const plan = await planAggClose(ctx, m, p, o.arb!, maxPremium, maxWethOut);
    if (!plan) {
      note(`aggclose:${label}`, tr(`[${label}] 聚合器也找不到 ${pct(maxPremium)} 內的價格`, `[${tag(label)}] the aggregator has no price within ${pct(maxPremium)} either`));
      return false;
    }
    const q = m.quotes.find((x) => x.stable === plan.stable)!;
    return (await act(label, "closeVia", q, [plan.stable, plan.w, plan.stableIn, maxPremium, plan.route.router, plan.route.data])) === "sent";
  };

  /// 從 WETH 最便宜的池子開始，試到送出一筆為止。
  /// 這種穩定幣的抵押只夠買一點點（< MIN_WETH_PER_TX）的池子跳過：便宜但每次只能買一點，會拖慢降槓桿
  const closeCheapest = async (m: Market, p: Position, maxPremium: bigint, label: string, maxWethOut = 0n) => {
    const debtLeft = maxWethOut > 0n && maxWethOut < p.debt ? maxWethOut : p.debt;
    for (const q of [...m.quotes].reverse()) {
      if (q.premiumBps > maxPremium) break;
      if (q.kind !== "uni") continue; // Aerodrome／Velodrome 池子合約不能直接 flash swap
      const coll = p.collateral.get(q.stable) ?? 0n;
      if (coll === 0n) continue; // 合約只能用這個池子的穩定幣付
      const collWeth = (coll * m.stablePrice.get(q.stable)! * 10n ** 18n) / (m.wethPrice * 10n ** BigInt(q.stableDecimals));
      if (collWeth < CFG.minWethPerTx && collWeth < debtLeft) continue;
      if ((await act(label, "close", q, [q.address, maxPremium, maxWethOut])) === "sent") return true;
    }
    return false;
  };

  /// 單筆上限：MAX_WETH_PER_TX、Aave 還能借出的 WETH（留 5%）、這種穩定幣在 Aave 還能存多少（換算成 WETH，留 5%）
  const openCap = (m: Market, q: Quote) => {
    const borrowRoom = (m.wethBorrowable * 95n) / 100n;
    const room = m.stableRoom.get(q.stable)!;
    // 賣 W 顆收到約 W × 預言機價 × (1+溢價) 的穩定幣，全部要存進 Aave
    const supplyRoom =
      room === MAX_UINT
        ? MAX_UINT
        : (room * 95n * m.stablePrice.get(q.stable)! * 10n ** 18n * 10_000n) /
          (100n * m.wethPrice * 10n ** BigInt(q.stableDecimals) * (10_000n + (q.premiumBps > 0n ? q.premiumBps : 0n)));
    let cap = borrowRoom < supplyRoom ? borrowRoom : supplyRoom;
    if (CFG.maxWethPerTx > 0n && CFG.maxWethPerTx < cap) cap = CFG.maxWethPerTx;
    return cap;
  };

  const step = async (hint?: bigint) => {
    const block = hint ?? (await ctx.client.getBlockNumber());
    if (block <= lastBlock) return; // 備援 RPC 可能落後一兩個區塊，舊的不要再判斷一次
    lastBlock = block;
    const [m, p, eth] = await Promise.all([
      readMarket(ctx, block),
      o.arb ? readPosition(ctx, o.arb) : undefined,
      o.sender ? ctx.client.getBalance({ address: o.owner! }) : undefined,
    ]);
    await checkAgg();
    const hasPosition = !!p && (p.debt > 0n || [...p.collateral.values()].some((v) => v > 0n));
    gasLow = eth !== undefined && hasPosition && eth < gasFloor(k);
    // 能開倉的池子：溢價夠、穩定幣能存、不是死池；死池或存不進去的池子顯示的溢價不算數
    // 聚合器能用時，Aerodrome／Velodrome 池子的溢價也算（聚合器賣得到）
    const openable = m.quotes.filter(
      (q) =>
        (q.kind === "uni" || aggReady) &&
        q.premiumBps >= CFG.openPremiumBps &&
        !m.wethFrozen &&
        m.stableOk.get(q.stable) &&
        m.stableRoom.get(q.stable)! > 0n &&
        q.poolWeth >= CFG.minPoolWeth,
    );
    if (openable.length) premiumSince ??= Date.now();
    else premiumSince = undefined;
    const best = livePools(m)[0] ?? m.quotes[0];
    // 沒事時每 LOG_MS 印一行；溢價過了門檻一半、有持倉或有交易在等時每個區塊都印
    if (Date.now() - lastLog >= CFG.logMs || best.premiumBps * 2n >= CFG.openPremiumBps || (p && p.debt > 0n) || pending) {
      console.log(describe(ctx, m, p));
      lastLog = Date.now();
    }
    alerts.update(m, p, o.sender ? true : botAlive(k), { actionFailures, gasLow });
    if (!o.arb || !p) return;
    if (gasLow) {
      const [left, want] = [formatUnits(eth!, 18), formatUnits(gasFloor(k) * 2n, 18)];
      note("gas", tr(`錢包 ETH 只剩 ${left}，持倉中最好補到 ${want} 以上`, `wallet has only ${left} ETH left; with a position open, top it up to at least ${want}`));
    }

    if (pending) {
      let r = await ctx.client.getTransactionReceipt({ hash: pending.hash }).catch(() => undefined);
      let dropped = "";
      let unknownDone = false;
      if (!r) {
        const used = await ctx.client.getTransactionCount({ address: o.owner!, blockTag: "latest" });
        if (used > pending.nonce) {
          // nonce 用掉了：多半是已經上鏈、只是剛剛查收據失敗（RPC 慢）；再查一次，還是沒有就當作結束了（不算失敗）
          r = await ctx.client.getTransactionReceipt({ hash: pending.hash }).catch(() => undefined);
          if (!r) unknownDone = true;
        }
        else if (MAINNET_FLASHBOTS.test(ctx.chain.sendRpcUrl) && m.block >= pending.block + 2n) {
          const st = await fetch(`https://protect.flashbots.net/tx/${pending.hash}`, { signal: AbortSignal.timeout(5_000) })
            .then((res) => res.json() as Promise<{ status?: string }>)
            .catch(() => ({ status: undefined }));
          // FAILED／CANCELLED 是確定的；UNKNOWN 可能只是狀態 API 還沒同步，多等幾個區塊才算
          if (st.status === "FAILED" || st.status === "CANCELLED") dropped = tr(`Flashbots 回 ${st.status}`, `Flashbots returned ${st.status}`);
          else if (st.status === "UNKNOWN" && m.block >= pending.block + 5n) dropped = tr("Flashbots 5 個區塊都查不到", "Flashbots still has no record after 5 blocks");
        }
        const window = k === "mainnet" ? 10n : 25n * BigInt(blocksPerMainnetBlock(k));
        if (!dropped && m.block > pending.block + window) dropped = tr("等太久沒上鏈", "not mined after waiting too long");
      }
      if (r) {
        const ok = r.status === "success";
        say(tr(`[${pending.label}] ${ok ? "成功" : "失敗"} @ #${r.blockNumber}，gas ${r.gasUsed}`, `[${tag(pending.label)}] ${ok ? "success" : "failed"} @ #${r.blockNumber}, gas ${r.gasUsed}`));
        if (r.status !== "success") actionFailures++;
        if (pending.label === "存本金" && r.status === "success" && pending.token) {
          o.pendingDeposits = o.pendingDeposits?.filter((d) => d.token !== pending!.token);
          o.onDeposited?.(pending.token);
        }
        pending = undefined;
      } else if (unknownDone) {
        say(
          tr(
            `[${pending.label}] nonce 已經用掉但查不到收據，當作結束了，下個區塊照實際部位判斷`,
            `[${tag(pending.label)}] nonce already used but no receipt found; treating it as done, the next block goes by the actual position`,
          ),
        );
        pending = undefined;
      } else if (dropped) {
        say(tr(`[${pending.label}] 沒上鏈（${dropped}），放行`, `[${tag(pending.label)}] not mined (${dropped}), moving on`));
        actionFailures++;
        pending = undefined;
      } else return;
    }

    if (!CFG.closeOnly) {
      for (const dep of o.pendingDeposits ?? []) {
        if (!o.sender || !m.stableOk.get(dep.token) || m.stableRoom.get(dep.token)! === 0n) continue;
        const [bal, allowance] = await Promise.all([
          ctx.client.readContract({ address: dep.token, abi: erc20Abi, functionName: "balanceOf", args: [o.owner!] }),
          ctx.client.readContract({ address: dep.token, abi: erc20Abi, functionName: "allowance", args: [o.owner!, o.arb] }),
        ]);
        const amount = [dep.amount, bal, allowance, m.stableRoom.get(dep.token)!].reduce((a, b) => (a < b ? a : b));
        if (amount === 0n) continue;
        const [amt, name] = [formatUnits(amount, ctx.decimals.get(dep.token)!), stableName(ctx, dep.token)];
        say(tr(`[存本金] Aave 可以存了，存 ${amt} ${name}`, `[deposit] Aave accepts deposits now, depositing ${amt} ${name}`));
        await send("存本金", encodeFunctionData({ abi: arbAbi, functionName: "deposit", args: [dep.token, amount] }), dep.token);
        return;
      }
    }

    if (p.debt > 0n && p.hf < CFG.emergencyHf) {
      const w = emergencyBuyback(p, m.wethPrice, CFG.emergencyMaxPremiumBps, CFG.emergencyTargetHf);
      const [ww, target] = [formatUnits(w, 18), formatUnits(CFG.emergencyTargetHf, 18)];
      say(
        tr(
          `HF ${fmtHf(p.hf)} 低於 EMERGENCY_HF，${w === 0n ? "全部買回" : `買回 ${ww} WETH 讓 HF 回到 ${target}`}`,
          `HF ${fmtHf(p.hf)} below EMERGENCY_HF, ${w === 0n ? "buying back everything" : `buying back ${ww} WETH to bring HF back to ${target}`}`,
        ),
      );
      if (!(await closeCheapest(m, p, CFG.emergencyMaxPremiumBps, "緊急降槓桿", w)) && !(await aggClose(m, p, CFG.emergencyMaxPremiumBps, "緊急降槓桿", w))) {
        const max = pct(CFG.emergencyMaxPremiumBps);
        note(
          "emergency",
          tr(
            `沒有池子能在 ${max} 內買回；把穩定幣直接轉進合約 ${o.arb} 可以讓它付得起，或用 repayFromOwner 直接拿 WETH 還`,
            `no pool can buy back within ${max}; send stablecoins straight to contract ${o.arb} so it can pay, or repay with WETH via repayFromOwner`,
          ),
        );
      }
      return;
    }

    if (openable.length && !CFG.closeOnly) {
      const waited = (Date.now() - premiumSince!) / 1000;
      if (waited < CFG.confirmSeconds) {
        const [name, prem, secs] = [openable[0].name, pct(openable[0].premiumBps), waited.toFixed(0)];
        note(
          "confirm",
          tr(`${name} 溢價 ${prem}，已持續 ${secs} 秒，滿 ${CFG.confirmSeconds} 秒才開`, `${name} premium ${prem}, held for ${secs}s, opening once it reaches ${CFG.confirmSeconds}s`),
        );
        return;
      }
      // 先問聚合器（每種穩定幣用它溢價最高的池子當代表），不夠好才用單一 Uniswap 池子
      if (aggReady) {
        const seen = new Set<Address>();
        for (const q of openable) {
          if (seen.has(q.stable)) continue;
          seen.add(q.stable);
          if ((await aggOpen(m, q)) === "sent") return;
        }
      }
      for (const q of openable) {
        if (q.kind !== "uni") continue;
        const cap = openCap(m, q);
        if (cap < CFG.minWethPerTx) {
          note(
            `cap:${q.address}`,
            tr(
              `${q.name} 溢價 ${pct(q.premiumBps)}，但 Aave 可借的 WETH 或 ${q.stableName} 可存的額度不夠`,
              `${q.name} premium ${pct(q.premiumBps)}, but Aave doesn't have enough borrowable WETH or ${q.stableName} supply room`,
            ),
          );
          continue;
        }
        // 先用「溢價的一半」估規模（第一筆就開足），健康因子不夠的話合約會擋，再退回最保守的估法
        const half = q.premiumBps / 2n > CFG.minEdgeBps ? q.premiumBps / 2n : CFG.minEdgeBps;
        let r = await act("開倉", "open", q, [q.address, CFG.minEdgeBps, half, CFG.targetHf, cap]);
        if (r === "skip" && half > CFG.minEdgeBps) r = await act("開倉", "open", q, [q.address, CFG.minEdgeBps, CFG.minEdgeBps, CFG.targetHf, cap]);
        if (r === "sent") return;
      }
      return; // 能用的池子價差還在：抱著，不平倉
    }
    if (CFG.closeOnly && openable.length) note("closeOnly", tr("CLOSE_ONLY 模式：有溢價也不開倉", "CLOSE_ONLY mode: not opening despite the premium"));

    if (p.debt > 0n && !(await closeCheapest(m, p, CFG.closePremiumBps, "平倉"))) {
      // 單一池子都平不了（例如都被推到價格上限）：價差已經收斂的話，問聚合器
      if (livePools(m).some((q) => q.premiumBps <= CFG.closePremiumBps)) await aggClose(m, p, CFG.closePremiumBps, "平倉");
    }
  };

  let lastTickAt = 0;
  const tick = async (hint?: bigint) => {
    if (busy || Date.now() - lastTickAt < CFG.minTickMs) return;
    busy = true;
    lastTickAt = Date.now();
    try {
      await step(hint);
    } catch (e) {
      console.error(tr(`${ts()} [${ctx.chain.name}] 這個區塊出錯：${errMsg(e)}`, `${ts()} [${ctx.chain.name}] error on this block: ${errMsg(e)}`));
    } finally {
      busy = false;
      // 心跳在判斷之後寫；只有能送交易的機器人才寫（只能看不能動的鏈，bot_not_running 還是要報）。寫失敗（例如磁碟滿）不影響交易
      if (o.sender && lastBlock > 0n) {
        try {
          writeFileSync(heartbeatFile(k), `${JSON.stringify({ time: new Date().toISOString(), block: lastBlock.toString(), arb: o.arb, actionFailures, gasLow })}\n`);
        } catch {}
      }
    }
  };
  await tick();
  setInterval(() => tick(), CFG.pollMs); // 輪詢當後備：WS 斷線或沒設定時照樣會跑
  if (ctx.chain.wsUrl) {
    const ws = createPublicClient({ chain: ctx.chain.chain, transport: webSocket(ctx.chain.wsUrl, { reconnect: true, keepAlive: true }) });
    ws.watchBlockNumber({
      onBlockNumber: (n) => void tick(n),
      onError: (e) => note("ws", tr(`新區塊訂閱出錯（${errMsg(e)}），靠輪詢繼續`, `new-block subscription error (${errMsg(e)}), continuing with polling`)),
    });
  }
  await new Promise(() => {}); // 一直跑到 Ctrl+C
}

/// 「25 個主網區塊」換算成這條鏈的區塊數，用來判斷交易是不是被丟掉了
const blocksPerMainnetBlock = (k: ChainKey) => ({ mainnet: 1, arbitrum: 48, base: 6, optimism: 6 })[k];

// ───────────────────────────── 警示 ─────────────────────────────
// 格式：{level, code, kind, message}，kind 都是 condition（還成立就會一直出現）。
// code 後面接 :鏈，例如 premium_open:arbitrum，跟 nas 的 code:主體 一樣，不同鏈出事算不同的消息。

export type Finding = { level: "critical" | "warning" | "info"; code: string; kind: "condition"; message: string };

const heartbeatFile = (k: ChainKey) => fileURLToPath(new URL(`heartbeat-${k}.json`, import.meta.url));
/// 機器人每個區塊會寫一次 heartbeat-<鏈>.json；一分鐘內有寫過就當它還在跑
export const botAlive = (k: ChainKey) => {
  try {
    return Date.now() - statSync(heartbeatFile(k)).mtimeMs < 60_000;
  } catch {
    return false;
  }
};

/// 機器人自己的健康狀況：連續失敗次數、gas 夠不夠。跑著的機器人直接傳；`check` 從心跳檔讀
export type BotHealth = { actionFailures: number; gasLow: boolean };
export const readHealth = (k: ChainKey): BotHealth | undefined => {
  try {
    const h = JSON.parse(readFileSync(heartbeatFile(k), "utf8"));
    return { actionFailures: Number(h.actionFailures ?? 0), gasLow: Boolean(h.gasLow) };
  } catch {
    return undefined;
  }
};

/// premiumActive：上一輪已經在報溢價了。溢價要掉到門檻 − 1%（門檻低於 2% 時是一半）以下才算結束，不然在門檻附近會一直開開關關
export function findings(ctx: Ctx, m: Market, p: Position | undefined, alive: boolean, premiumActive = false, health?: BotHealth): Finding[] {
  const out: Finding[] = [];
  const k = ctx.chain.key;
  const n = ctx.chain.name;
  const best = livePools(m)[0] ?? m.quotes[0];
  const debt = p?.debt ?? 0n;
  const off = CFG.openPremiumBps > 200n ? CFG.openPremiumBps - 100n : CFG.openPremiumBps / 2n;
  const threshold = premiumActive ? off : CFG.openPremiumBps;
  if (best.premiumBps >= threshold) {
    const blocked = m.wethFrozen || !m.stableOk.get(best.stable);
    out.push({
      level: "warning",
      code: `premium_open:${k}`,
      kind: "condition",
      message: tr(
        `${n} Uniswap ${best.name} 的 ETH 比 Aave 預言機貴 ${pct(best.premiumBps)}${blocked ? "，但 Aave 凍結中，借不到" : ""}`,
        `${n} Uniswap ${best.name}: ETH is ${pct(best.premiumBps)} above the Aave oracle${blocked ? ", but Aave is frozen, can't borrow" : ""}`,
      ),
    });
  }
  if (debt > 0n && p!.hf < CFG.emergencyHf) {
    const [hf, min] = [fmtHf(p!.hf), formatUnits(CFG.emergencyHf, 18)];
    out.push({ level: "critical", code: `hf_low:${k}`, kind: "condition", message: tr(`${n} 健康因子 ${hf}，低於 ${min}，有清算風險`, `${n} health factor ${hf}, below ${min}, liquidation risk`) });
  }
  if ((out.length > 0 || debt > 0n) && !alive) {
    out.push({
      level: "warning",
      code: `bot_not_running:${k}`,
      kind: "condition",
      message: tr(`${n} 有機會或有持倉，但這條鏈沒有在跑的套利機器人（node start.ts）`, `${n} has an opportunity or an open position, but no arb bot is running on this chain (node start.ts)`),
    });
  }
  if (health && health.actionFailures >= CFG.actionFailAlert) {
    const x = health.actionFailures;
    out.push({
      level: "warning",
      code: `action_failing:${k}`,
      kind: "condition",
      message: tr(`${n} 機器人連續 ${x} 次動作沒成功（模擬失敗或交易沒上鏈），看 trader.sh logs`, `${n} bot failed ${x} actions in a row (simulation failed or tx not mined), see trader.sh logs`),
    });
  }
  if (health?.gasLow) {
    out.push({
      level: "warning",
      code: `gas_low:${k}`,
      kind: "condition",
      message: tr(`${n} 錢包的 ETH 快不夠付 gas 了（有部位時，緊急降槓桿會送不出去）`, `${n} wallet is running low on ETH for gas (with a position open, an emergency deleverage can't be sent)`),
    });
  }
  if (debt > 0n) {
    const [d, hf] = [Number(formatUnits(debt, 18)).toFixed(3), fmtHf(p!.hf)];
    out.push({ level: "info", code: `position_open:${k}`, kind: "condition", message: tr(`${n} 持倉中：債 ${d} WETH，健康因子 ${hf}`, `${n} position open: debt ${d} WETH, health factor ${hf}`) });
  }
  if (m.wethFrozen) out.push({ level: "info", code: `aave_frozen:${k}`, kind: "condition", message: tr(`${n} Aave V3 的 WETH 凍結中，不能借`, `${n} Aave V3 WETH is frozen, can't borrow`) });
  return out;
}

/// 清單有變化（新出現或消失）才 POST 到 ALERT_WEBHOOK_URL；第一輪只在有 warning／critical 時送
class Alerts {
  private last?: Set<string>;
  private ctx: Ctx;

  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  /// 不等 webhook 回應（不擋交易判斷）
  update(m: Market, p: Position | undefined, alive: boolean, health?: BotHealth) {
    const now = findings(this.ctx, m, p, alive, this.last?.has(`premium_open:${this.ctx.chain.key}`), health);
    const codes = new Set(now.map((f) => f.code));
    const added = [...codes].filter((c) => !this.last?.has(c));
    const resolved = [...(this.last ?? [])].filter((c) => !codes.has(c));
    const first = !this.last;
    this.last = codes;
    if (first ? !now.some((f) => f.level !== "info") : added.length + resolved.length === 0) return;
    for (const f of now.filter((f) => added.includes(f.code))) console.log(tr(`  [警示] ${f.level} ${f.code}：${f.message}`, `  [alert] ${f.level} ${f.code}: ${f.message}`));
    for (const c of resolved) console.log(tr(`  [警示] 已恢復 ${c}`, `  [alert] resolved ${c}`));
    if (!CFG.alertWebhookUrl) return;
    const headers: Record<string, string> = { "content-type": "application/json" };
    const i = CFG.alertWebhookHeader.indexOf(":");
    if (i > 0) headers[CFG.alertWebhookHeader.slice(0, i).trim()] = CFG.alertWebhookHeader.slice(i + 1).trim();
    const body = {
      source: "aave-u-eth",
      host: hostname(),
      chain: this.ctx.chain.key,
      time: new Date().toISOString(),
      block: m.block.toString(),
      findings: now,
      new: added,
      resolved,
    };
    fetch(CFG.alertWebhookUrl, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) })
      .then((r) => {
        if (!r.ok) console.log(tr(`  [警示] webhook 回 ${r.status}`, `  [alert] webhook returned ${r.status}`));
      })
      .catch((e) => console.log(tr(`  [警示] webhook 送不出去：${errMsg(e)}`, `  [alert] webhook failed: ${errMsg(e)}`)));
  }
}

// ───────────────────────────── 出場 ─────────────────────────────

/// 一直買回直到債務歸零（大部位一次買不完），再把所有抵押提回 owner 錢包，最後掃掉合約裡的零頭
export async function exitAll(ctx: Ctx, arb: Address, sender: Sender) {
  const owner = sender.account.address;
  const n = ctx.chain.name;
  for (let round = 1; ; round++) {
    const p = await readPosition(ctx, arb);
    if (p.debt === 0n) break;
    if (round > 30) {
      const d = formatUnits(p.debt, 18);
      throw new Error(tr(`${n} 買了 30 輪還有 ${d} WETH 債，先停下來`, `${n} still has ${d} WETH debt after 30 rounds, stopping`));
    }
    const m = await readMarket(ctx);
    if (round > 1) console.log(describe(ctx, m, p));
    let closed = false;
    let small: Quote | undefined; // 只買得到一點點的池子，沒有更好的才用
    for (const q of [...m.quotes].reverse()) {
      if (q.premiumBps > CFG.exitMaxPremiumBps) break;
      if (q.kind !== "uni") continue;
      const coll = p.collateral.get(q.stable) ?? 0n;
      if (coll === 0n) continue; // 合約只能提這個池子的穩定幣來付
      try {
        const [weth, paid] = await simulate(ctx, arb, owner, "close", [q.address, CFG.exitMaxPremiumBps, 0n]);
        // 只買得到一點點（這種穩定幣快用完、或池子很淺一下就到價格上限）：先記著，看別的池子能不能買多一點
        if (weth < CFG.minWethPerTx && weth < p.debt) {
          small ??= q;
          continue;
        }
        const [w, s] = [formatUnits(weth, 18), formatUnits(paid, q.stableDecimals)];
        console.log(
          tr(`  [${n}] 第 ${round} 輪：在 ${q.name} 買回 ${w} WETH，付 ${s} ${q.stableName}`, `  [${n}] round ${round}: buy back ${w} WETH on ${q.name}, pay ${s} ${q.stableName}`),
        );
        await sender.call(tr("平倉", "close"), arb, "close", [q.address, CFG.exitMaxPremiumBps, 0n]);
        closed = true;
        break;
      } catch (e) {
        console.log(tr(`  [${n}] ${q.name} 不行：${errMsg(e)}`, `  [${n}] ${q.name} failed: ${errMsg(e)}`));
      }
    }
    if (!closed && aggregatorOn() && (await ctx.client.readContract({ address: arb, abi: arbAbi, functionName: "routers", args: [KYBER_ROUTER] }).catch(() => false))) {
      const plan = await planAggClose(ctx, m, p, arb, CFG.exitMaxPremiumBps);
      if (plan) {
        try {
          await simulate(ctx, arb, owner, "closeVia", [plan.stable, plan.w, plan.stableIn, CFG.exitMaxPremiumBps, plan.route.router, plan.route.data]);
          const [w, s, name] = [formatUnits(plan.w, 18), formatUnits(plan.stableIn, ctx.decimals.get(plan.stable)!), stableName(ctx, plan.stable)];
          console.log(tr(`  [${n}] 第 ${round} 輪：經聚合器買回 ${w} WETH，付 ${s} ${name}`, `  [${n}] round ${round}: buy back ${w} WETH via the aggregator, pay ${s} ${name}`));
          await sender.call(tr("平倉", "close"), arb, "closeVia", [plan.stable, plan.w, plan.stableIn, CFG.exitMaxPremiumBps, plan.route.router, plan.route.data]);
          closed = true;
        } catch (e) {
          console.log(tr(`  [${n}] 聚合器不行：${errMsg(e)}`, `  [${n}] aggregator failed: ${errMsg(e)}`));
        }
      }
    }
    if (!closed && small) {
      console.log(tr(`  [${n}] 第 ${round} 輪：只剩 ${small.name} 能買，買一點是一點`, `  [${n}] round ${round}: only ${small.name} can still buy, taking what it can`));
      await sender.call(tr("平倉", "close"), arb, "close", [small.address, CFG.exitMaxPremiumBps, 0n]);
      closed = true;
    }
    if (!closed) {
      // 說清楚為什麼：每種有抵押的穩定幣，是價格太貴，還是 Aave 的現金不夠提不出來
      const reasons: string[] = [];
      for (const [stable, coll] of p.collateral) {
        if (coll === 0n) continue;
        const name = stableName(ctx, stable);
        const pools = m.quotes.filter((q) => q.stable === stable && q.kind === "uni");
        if (!pools.length) continue;
        const cheapest = pools.reduce((a, b) => (a.premiumBps < b.premiumBps ? a : b));
        if (cheapest.premiumBps > CFG.exitMaxPremiumBps) {
          const [prem, max] = [pct(cheapest.premiumBps), pct(CFG.exitMaxPremiumBps)];
          reasons.push(
            tr(
              `${name} 的池子最便宜也比預言機貴 ${prem}（上限 ${max}，可以晚點再跑或調高 EXIT_MAX_PREMIUM_BPS）`,
              `${name}: even the cheapest pool is ${prem} above the oracle (limit ${max}; run again later or raise EXIT_MAX_PREMIUM_BPS)`,
            ),
          );
          continue;
        }
        const affordable = await ctx.client.readContract({ address: arb, abi: arbAbi, functionName: "wethAffordable", args: [stable, cheapest.fee, CFG.exitMaxPremiumBps] });
        if (affordable === 0n) {
          reasons.push(
            tr(
              `Aave 的 ${name} 現金被借光了，抵押提不出來；把 ${name} 直接轉進合約 ${arb} 就能拿來付`,
              `Aave's ${name} cash is fully borrowed, so the collateral can't be withdrawn; send ${name} straight to contract ${arb} to pay with it`,
            ),
          );
        } else reasons.push(tr(`${name} 模擬失敗（看上面的錯誤）`, `${name} simulation failed (see the error above)`));
      }
      const d = formatUnits(p.debt, 18);
      throw new Error(
        tr(
          `${n} 還有 ${d} WETH 債，這一輪平不掉：\n  ${reasons.join("\n  ") || "合約裡沒有穩定幣抵押"}`,
          `${n} still has ${d} WETH debt and can't close it this round:\n  ${reasons.join("\n  ") || "no stablecoin collateral in the contract"}`,
        ),
      );
    }
  }

  const p = await readPosition(ctx, arb);
  for (const [stable, amount] of p.collateral) {
    if (amount === 0n) continue;
    const [a, name] = [formatUnits(amount, ctx.decimals.get(stable)!), stableName(ctx, stable)];
    console.log(tr(`  [${n}] 提領 ${a} ${name} 回錢包`, `  [${n}] withdraw ${a} ${name} to the wallet`));
    await sender.call(tr("提領", "withdraw"), arb, "withdraw", [stable, MAX_UINT, owner]);
  }
  for (const token of [ctx.chain.weth, ...Object.values(ctx.chain.stables)]) {
    const bal = await ctx.client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [arb] });
    if (bal > 0n) await sender.call(tr("掃零頭", "sweep dust"), arb, "sweep", [token, owner]);
  }
}
