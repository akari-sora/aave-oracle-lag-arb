// 用法（在 bot 資料夾裡）：
//   node start.ts            給錢包 → 每條鏈：第一次部署合約、存本金 → 開始自動套利
//   node start.ts exit       每條鏈都平倉，把錢全部提回錢包
//   node start.ts status     看合約部位（不用 key）
//   node start.ts watch      只看價差（不用 key）；設了 ALERT_WEBHOOK_URL 會在有變化時推送
//   node start.ts check      跑一次就結束，給排程或 agent 用；有機會或有風險時結束碼 1（--json 印清單；--state <檔案> 只報變化）
//   node start.ts forget     刪掉 macOS 鑰匙圈裡記住的錢包
// 選項：--yes 不問確認；--deposit <數量|all|0>（每條鏈各存這麼多）；--token USDC|USDT；--chains mainnet,arbitrum；--account <Foundry 帳戶名>
//   node start.ts whoami     印出錢包地址和各鏈餘額（確認 key 讀得到）
// 錢包可以貼私鑰、助記詞、keystore 檔路徑、op://（1Password），或用環境變數 PRIVATE_KEY／MNEMONIC／KEY（同樣接受上面這些）、
// KEY_ENV=<另一個環境變數的名稱>、KEY_FILE=<檔案路徑>。
// 助記詞預設會掃 MetaMask 和 Ledger Live 常用的幾個地址讓你選；MNEMONIC_INDEX 或 MNEMONIC_PATH 可以直接指定
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  encodeDeployData,
  encodeFunctionData,
  formatEther,
  formatUnits,
  getContractAddress,
  parseAbi,
  parseUnits,
  toHex,
  type Abi,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { accountFor, candidatePaths, cleanInput, keychainAvailable, keychainDelete, keychainLoad, keychainSave, parseSecret, type Secret } from "./keys.ts";
import {
  CFG,
  CHAINS,
  KYBER_ROUTER,
  aggregatorOn,
  Sender,
  arbAbi,
  botAlive,
  checkConfig,
  describe,
  erc20Abi,
  errMsg,
  exitAll,
  findings,
  loadCtx,
  readMarket,
  readHealth,
  readPosition,
  runBot,
  stableName,
  type ChainKey,
  type Ctx,
  type Finding,
} from "./core.ts";
import { tr } from "./i18n.ts";

const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith("--") ? args[0] : "start";
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? "") : undefined;
};
const YES = args.includes("--yes");
const chainsFlag = flag("chains")?.split(",");
const chains = CHAINS.filter((c) => !chainsFlag || chainsFlag.includes(c.key));

// ───────────────────────────── 輸入 ─────────────────────────────

let lines: AsyncIterator<string> | undefined;
async function ask(q: string) {
  process.stdout.write(q);
  lines ??= createInterface({ input: process.stdin, terminal: false })[Symbol.asyncIterator]();
  const r = await lines.next();
  if (!process.stdin.isTTY) process.stdout.write("\n");
  return r.done ? "" : r.value.trim();
}

async function confirm(q: string, defaultYes = false) {
  if (YES) return true;
  const a = await ask(`${q} ${defaultYes ? "(Y/n)" : "(y/N)"} `);
  return a === "" ? defaultYes : /^y/i.test(a);
}

/// 終端機輸入時不顯示；被 pipe 進來時就當一般輸入。password：只拿掉控制碼，空白和引號照留
async function askHidden(q: string, password = false): Promise<string> {
  if (!process.stdin.isTTY || lines) return ask(q);
  process.stdout.write(q);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let buf = "";
    const onData = (s: string) => {
      for (const [i, ch] of [...s].entries()) {
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          const rest = [...s].slice(i + 1).join("");
          if (rest) stdin.unshift(rest); // 同一批進來的後續輸入留給下一個問題
          const clean = password ? buf.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f]/g, "") : cleanInput(buf);
          const words = password ? 1 : clean.split(/\s+/).length;
          process.stdout.write(
            tr(`（收到 ${words > 1 ? `${words} 個單字` : `${clean.length} 個字元`}）\n`, `(got ${words > 1 ? `${words} words` : `${clean.length} characters`})\n`),
          );
          resolve(clean);
          return;
        }
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function getAccount(ctxs: Ctx[]): Promise<LocalAccount> {
  // 環境變數：PRIVATE_KEY／MNEMONIC／KEY 直接放值；KEY_ENV 指向另一個變數名稱（例如安全儲存注入的）；KEY_FILE 指向放 key 的檔案
  const indirect = process.env.KEY_ENV ? process.env[process.env.KEY_ENV] : undefined;
  if (process.env.KEY_ENV && !indirect) {
    const v = process.env.KEY_ENV;
    throw new Error(tr(`KEY_ENV=${v}，但環境變數 ${v} 是空的`, `KEY_ENV=${v}, but environment variable ${v} is empty`));
  }
  const fromEnv =
    process.env.PRIVATE_KEY || process.env.MNEMONIC || process.env.KEY || indirect || (process.env.KEY_FILE ? readFileSync(process.env.KEY_FILE, "utf8") : undefined);
  let raw = fromEnv ?? (flag("account") ? `foundry:${flag("account")}` : undefined);
  let fromKeychain = false;
  if (!raw) {
    const saved = keychainLoad();
    if (saved && (await confirm(tr(`用 macOS 鑰匙圈裡記住的錢包 ${saved.address}？`, `Use the wallet saved in the macOS Keychain, ${saved.address}?`), true))) {
      [raw, fromKeychain] = [saved.secret, true];
    }
  }
  raw ??= await askHidden(tr("貼上私鑰、助記詞、keystore 檔路徑或 op://…（不會顯示，也不會存檔）：", "Paste a private key, mnemonic, keystore file path or op://… (hidden, not saved): "));
  const secret = await parseSecret(raw, (q) => askHidden(q, true));
  if (secret.kind === "mnemonic") {
    const n = secret.phrase.split(/\s+/).length;
    console.log(tr(`助記詞：${secret.language}，${n} 個字，檢查碼正確`, `Mnemonic: ${secret.language}, ${n} words, checksum OK`));
  } else if (secret.source !== "私鑰") console.log(tr(`從 ${secret.source} 讀到私鑰`, `Read the private key from ${secret.source}`));

  const account = secret.kind === "mnemonic" ? await pickFromMnemonic(secret, ctxs) : accountFor(secret);
  console.log(tr(`錢包 ${account.address}（每條鏈都是這個地址）`, `Wallet ${account.address} (same address on every chain)`));
  if (!fromKeychain && !(await confirm(tr("是這個錢包嗎？", "Is this the right wallet?"), true))) process.exit(0);

  // 只存選中那個地址的私鑰，不存整組助記詞
  if (!fromKeychain && !fromEnv && !YES && keychainAvailable() && process.stdin.isTTY) {
    if (
      await confirm(
        tr("要記在 macOS 鑰匙圈嗎？下次就不用再貼（node start.ts forget 可以刪掉）", "Save it in the macOS Keychain? Then you won't have to paste it next time (node start.ts forget removes it)"),
        false,
      )
    ) {
      const key = secret.kind === "privateKey" ? secret.key : toHex((account as ReturnType<typeof accountFor> & { getHdKey(): { privateKey: Uint8Array } }).getHdKey().privateKey);
      keychainSave(account.address, key);
      console.log(tr("已記在鑰匙圈（服務名稱 aave-u-eth）", "Saved in the Keychain (service name aave-u-eth)"));
    }
  }
  return account;
}

/// 列出這組助記詞常用的幾個地址在各鏈的 ETH、穩定幣和合約，讓人挑；預設挑第一個有錢的
async function pickFromMnemonic(secret: Extract<Secret, { kind: "mnemonic" }>, ctxs: Ctx[]): Promise<LocalAccount> {
  if (process.env.MNEMONIC_PATH) return accountFor(secret, process.env.MNEMONIC_PATH as `m/44'/60'/${string}`);
  if (process.env.MNEMONIC_INDEX) return accountFor(secret, `m/44'/60'/0'/0/${Number(process.env.MNEMONIC_INDEX)}`);
  const cands = candidatePaths().map((c) => ({ ...c, account: accountFor(secret, c.path) }));
  console.log(tr("查這組助記詞常用的地址在各條鏈上的餘額…", "Checking balances of this mnemonic's common addresses on each chain…"));
  const lookupFailed = tr("（查詢失敗）", "(lookup failed)");
  const state = loadState();
  const summaries = await Promise.all(
    cands.map(async (c) => {
      const parts = await Promise.all(
        ctxs.map(async (ctx) => {
          const [eth, wallet] = await Promise.all([ctx.client.getBalance({ address: c.account.address }), walletOf(ctx, c.account.address)]);
          const usd = wallet.reduce((sum, w) => sum + Number(formatUnits(w.bal, w.dec)), 0);
          const hasArb = Boolean(state[c.account.address.toLowerCase()]?.[ctx.chain.key]);
          if (eth === 0n && usd === 0 && !hasArb) return "";
          return `${ctx.chain.name} ${Number(formatEther(eth)).toFixed(4)} ETH ${usd.toFixed(0)} U${hasArb ? tr(" 有合約", " has contract") : ""}`;
        }),
      ).catch(() => [lookupFailed]);
      return parts.filter(Boolean).join(tr("｜", " | "));
    }),
  );
  cands.forEach((c, i) => console.log(`  ${i + 1}. ${c.label.padEnd(14)} ${c.account.address}  ${summaries[i] || tr("（空的）", "(empty)")}`));
  const suggested = Math.max(0, summaries.findIndex((s) => s && s !== lookupFailed));
  // 全自動時不猜：猜錯會把別的錢包的錢存進來，或重啟時換到另一個地址、丟下原本的部位
  if (YES) {
    throw new Error(
      tr(
        "全自動模式用助記詞，要指定地址：MNEMONIC_INDEX=<上面的編號減 1>（MetaMask 路徑），或 MNEMONIC_PATH=<完整路徑>",
        "With a mnemonic in non-interactive mode, pick the address: MNEMONIC_INDEX=<number above minus 1> (MetaMask path), or MNEMONIC_PATH=<full path>",
      ),
    );
  }
  const a = await ask(tr(`用哪一個？（Enter = ${suggested + 1}；其他路徑用 MNEMONIC_PATH）`, `Which one? (Enter = ${suggested + 1}; for other paths use MNEMONIC_PATH) `));
  const n = a === "" ? suggested : Number(a) - 1;
  if (!cands[n]) throw new Error(tr(`沒有第 ${a} 個`, `There is no number ${a}`));
  return cands[n].account;
}

// ───────────────────────────── 狀態檔 ─────────────────────────────
// 只記合約地址和待存的本金，不記 key：{ owner: { 鏈: Entry } }。換一把 key 就是另一組合約

type Entry = { arb: Address; pendingDeposits?: { token: Address; amount: string }[] };
type State = Record<string, Partial<Record<ChainKey, Entry>>>;
const STATE = fileURLToPath(new URL("state.json", import.meta.url));
const loadState = (): State => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {});
const saveState = (s: State) => writeFileSync(STATE, `${JSON.stringify(s, null, 2)}\n`);

/// ARB_ADDRESS_<鏈> 優先，其次 state.json；都沒有而且有 owner 時，從 owner 部署過的合約裡找（換機器、重裝也找得回來）
async function findArb(ctx: Ctx, owner?: Address): Promise<Address | undefined> {
  const k = ctx.chain.key;
  const fromEnv = process.env[`ARB_ADDRESS_${k.toUpperCase()}`] as Address | undefined;
  const state = loadState();
  const arb = fromEnv ?? (owner ? state[owner.toLowerCase()]?.[k]?.arb : Object.values(state).find((e) => e[k])?.[k]?.arb);
  if (arb) {
    const code = await ctx.client.getCode({ address: arb });
    if (code && code !== "0x") return arb;
  }
  if (!owner) return undefined;
  const found = await discoverArb(ctx, owner);
  if (found) {
    console.log(tr(`[${ctx.chain.name}] 找到這個錢包之前部署的合約 ${found}`, `[${ctx.chain.name}] found a contract this wallet deployed before: ${found}`));
    ((state[owner.toLowerCase()] ??= {})[k] ??= { arb: found }).arb = found;
    saveState(state);
  }
  return found;
}

/// 合約地址 = CREATE(owner, nonce)。掃 owner 最近 300 個 nonce，找 owner() 是自己、WETH() 是這條鏈 WETH 的；
/// 有好幾個時，優先選有抵押或債的，否則選最新的
async function discoverArb(ctx: Ctx, owner: Address): Promise<Address | undefined> {
  const n = await ctx.client.getTransactionCount({ address: owner });
  if (n === 0) return undefined;
  const nonces = Array.from({ length: Math.min(n, 300) }, (_, i) => n - 1 - i);
  const addrs = nonces.map((nonce) => getContractAddress({ from: owner, nonce: BigInt(nonce) }));
  const abi = parseAbi(["function owner() view returns (address)", "function WETH() view returns (address)"]);
  const res = await ctx.client.multicall({
    allowFailure: true,
    contracts: addrs.flatMap((address) => [
      { address, abi, functionName: "owner" } as const,
      { address, abi, functionName: "WETH" } as const,
    ]),
  });
  const mine = addrs.filter(
    (_, i) =>
      res[2 * i].status === "success" &&
      String(res[2 * i].result).toLowerCase() === owner.toLowerCase() &&
      String(res[2 * i + 1].result).toLowerCase() === ctx.chain.weth.toLowerCase(),
  );
  for (const a of mine) {
    const p = await readPosition(ctx, a);
    if (p.debt > 0n || [...p.collateral.values()].some((v) => v > 0n)) return a;
  }
  return mine[0]; // nonce 由大到小，第一個就是最新的
}

/// 每條鏈各自連；連不上的鏈印出來然後跳過，不擋其他鏈
async function loadCtxs(): Promise<Ctx[]> {
  const results = await Promise.allSettled(chains.map((c) => loadCtx(c)));
  return results.flatMap((r, i) => {
    if (r.status === "fulfilled") return [r.value];
    console.log(tr(`[${chains[i].name}] 連不上（${errMsg(r.reason)}），這次先跳過`, `[${chains[i].name}] can't connect (${errMsg(r.reason)}), skipping it this time`));
    return [];
  });
}

// ───────────────────────────── 合約 ─────────────────────────────

function loadArtifact(): { abi: Abi; bytecode: Hex; sourceHash: string } {
  const art = JSON.parse(readFileSync(new URL("OracleLagArb.json", import.meta.url), "utf8"));
  const sources = ["../src/OracleLagArb.sol", "../src/interfaces/External.sol"].map((p) => new URL(p, import.meta.url));
  if (sources.every((u) => existsSync(u))) {
    const h = createHash("sha256");
    for (const u of sources) h.update(readFileSync(u));
    if (h.digest("hex") !== art.sourceHash) {
      throw new Error(
        tr(
          "src/ 的合約跟 bot/OracleLagArb.json 對不上。改過合約要先 forge build，再跑 node export-artifact.ts",
          "The contract in src/ doesn't match bot/OracleLagArb.json. After changing the contract, run forge build, then node export-artifact.ts",
        ),
      );
    }
  }
  return art;
}

async function deploy(ctx: Ctx, sender: Sender): Promise<Address | undefined> {
  const art = loadArtifact();
  const c = ctx.chain;
  const data = encodeDeployData({ abi: art.abi, bytecode: art.bytecode, args: [c.aaveProvider, c.weth, c.uniFactory] });
  const gas = await ctx.client.estimateGas({ account: sender.account.address, data });
  const price = await ctx.client.getGasPrice();
  const cost = Number(formatEther((gas * price * 125n) / 100n)).toFixed(6);
  console.log(tr(`[${c.name}] 還沒有套利合約，要先部署（約 ${cost} ETH gas）`, `[${c.name}] no arb contract yet, it needs to be deployed first (about ${cost} ETH gas)`));
  if (!(await confirm(tr(`在 ${c.name} 部署？`, `Deploy on ${c.name}?`)))) return undefined;
  const r = await sender.sendAndWait(tr("部署合約", "deploy contract"), undefined, data);
  console.log(tr(`  [${c.name}] 合約 ${r.contractAddress}`, `  [${c.name}] contract ${r.contractAddress}`));
  return r.contractAddress!;
}

/// 建議的 gas 預算：主網開倉一筆約 60 萬 gas，行情來的時候 gas 很貴；L2 便宜很多
const minGas = (k: ChainKey) => (k === "mainnet" ? 5n * 10n ** 16n : 3n * 10n ** 15n);

// ───────────────────────────── 存本金 ─────────────────────────────

type Wallet = { name: string; token: Address; bal: bigint; dec: number }[];

async function walletOf(ctx: Ctx, owner: Address): Promise<Wallet> {
  return Promise.all(
    Object.entries(ctx.chain.stables).map(async ([name, token]) => ({
      name,
      token,
      bal: await ctx.client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
      dec: ctx.decimals.get(token)!,
    })),
  );
}

/// 每種錢包裡有的穩定幣（--token 指定的話只那一種）：問要存多少（--deposit all／數字／0 直接決定），授權後存進合約；
/// Aave 凍結、LTV = 0 或 supply cap 滿了存不進去的部分，記成待存，機器人在能存的那個區塊自動存
async function depositFlow(ctx: Ctx, sender: Sender, arb: Address, entry: Entry, wallet: Wallet) {
  const n = ctx.chain.name;
  const owner = sender.account.address;
  const tokenFlag = flag("token")?.toUpperCase();
  if (tokenFlag && !wallet.some((w) => w.name === tokenFlag)) {
    throw new Error(tr(`--token 只能是 ${wallet.map((w) => w.name).join("／")}`, `--token must be one of ${wallet.map((w) => w.name).join("/")}`));
  }
  const m = await readMarket(ctx);
  const pending = new Map((entry.pendingDeposits ?? []).map((d) => [d.token, BigInt(d.amount)]));

  for (const w of wallet.filter((w) => w.bal > 0n && (!tokenFlag || w.name === tokenFlag))) {
    const all = formatUnits(w.bal, w.dec);
    const raw =
      flag("deposit") ??
      (await ask(
        tr(`[${n}] 要存多少 ${w.name} 進合約當本金？（Enter = 全部 ${all}，0 = 不存）`, `[${n}] How much ${w.name} to deposit into the contract as capital? (Enter = all ${all}, 0 = none) `),
      ));
    const amount = raw === "" || raw === "all" ? w.bal : parseUnits(raw, w.dec);
    if (amount === 0n) continue;
    if (amount > w.bal) {
      console.log(tr(`[${n}] 錢包只有 ${all} ${w.name}，這種不存`, `[${n}] the wallet only has ${all} ${w.name}, not depositing this one`));
      continue;
    }

    const allowance = await ctx.client.readContract({ address: w.token, abi: erc20Abi, functionName: "allowance", args: [owner, arb] });
    if (allowance < amount) {
      const approve = (x: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [arb, x] });
      if (allowance > 0n && w.name === "USDT") await sender.sendAndWait(tr("USDT 授權歸零", "reset USDT approval"), w.token, approve(0n)); // USDT 不能直接改非零授權
      await sender.sendAndWait(tr(`授權 ${w.name}`, `approve ${w.name}`), w.token, approve(amount));
    }

    const room = m.stableOk.get(w.token) ? m.stableRoom.get(w.token)! : 0n;
    const now = amount < room ? amount : room;
    if (now > 0n) await sender.call(tr("存本金", "deposit"), arb, "deposit", [w.token, now]);
    if (amount > now) {
      const why = m.stableOk.get(w.token)
        ? tr(`Aave 的 ${w.name} 存款上限滿了`, `Aave's ${w.name} supply cap is full`)
        : tr(`Aave 現在凍結（或 ${w.name} 的 LTV 是 0）`, `Aave is frozen right now (or ${w.name} has an LTV of 0)`);
      const left = formatUnits(amount - now, w.dec);
      console.log(
        tr(
          `[${n}] ${why}，還有 ${left} ${w.name} 存不進去。授權已經給了，機器人會在能存的那個區塊自動存`,
          `[${n}] ${why}; ${left} ${w.name} can't be deposited yet. The approval is already in place, so the bot will deposit it in the first block where it can`,
        ),
      );
      pending.set(w.token, amount - now);
    } else pending.delete(w.token);
  }
  entry.pendingDeposits = [...pending].map(([token, a]) => ({ token, amount: a.toString() }));
  if (!entry.pendingDeposits.length) delete entry.pendingDeposits;
}

// ───────────────────────────── 指令 ─────────────────────────────

type Plan = { ctx: Ctx; sender?: Sender; arb?: Address };

/// 一條鏈的設定：部署（第一次）、存本金。只影響這條鏈，出錯由呼叫的人接住
async function setupChain(ctx: Ctx, account: LocalAccount, state: State): Promise<Plan> {
  const c = ctx.chain;
  const owner = account.address;
  const key = owner.toLowerCase();
  const [eth, wallet, existing] = await Promise.all([ctx.client.getBalance({ address: owner }), walletOf(ctx, owner), findArb(ctx, owner)]);
  const [ethStr, coins] = [Number(formatEther(eth)).toFixed(5), wallet.map((w) => `${formatUnits(w.bal, w.dec)} ${w.name}`)];
  console.log(tr(`\n[${c.name}] ETH ${ethStr}｜${coins.join("，")}｜送交易 ${c.sendRpcUrl}`, `\n[${c.name}] ETH ${ethStr} | ${coins.join(", ")} | sending via ${c.sendRpcUrl}`));
  const hasStable = wallet.some((w) => w.bal > 0n);
  if (eth === 0n) {
    // 有合約的話照樣讀部位、推警示（例如持倉中 gas 用完了，HF 變低還是要知道），只是不送交易
    console.log(
      tr(
        `[${c.name}] 沒有 ETH 付 gas，這條鏈只監控${existing ? "（有合約，會看部位）" : ""}`,
        `[${c.name}] no ETH for gas, only monitoring this chain${existing ? " (has a contract, will watch the position)" : ""}`,
      ),
    );
    return { ctx, arb: existing };
  }
  if (eth < minGas(c.key)) console.log(tr(`[${c.name}] ⚠ ETH 偏少，建議至少 ${formatEther(minGas(c.key))}`, `[${c.name}] ⚠ ETH is low, at least ${formatEther(minGas(c.key))} is recommended`));
  const sender = new Sender(account, ctx);
  const arb = existing ?? (hasStable && !CFG.closeOnly ? await deploy(ctx, sender) : undefined);
  if (!arb) {
    console.log(
      tr(`[${c.name}] 沒有合約${hasStable ? "" : "，錢包也沒有 USDC／USDT"}，這條鏈只監控`, `[${c.name}] no contract${hasStable ? "" : " and no USDC/USDT in the wallet"}, only monitoring this chain`),
    );
    return { ctx };
  }
  const arbOwner = await ctx.client.readContract({ address: arb, abi: arbAbi, functionName: "owner" });
  if (arbOwner.toLowerCase() !== key) throw new Error(tr(`合約 ${arb} 的 owner 是 ${arbOwner}，不是這個錢包`, `contract ${arb} is owned by ${arbOwner}, not this wallet`));
  const entry = ((state[key] ??= {})[c.key] ??= { arb });
  entry.arb = arb;
  saveState(state);

  // 聚合器路徑：把 KyberSwap router 加進合約白名單（一次就好）
  if (aggregatorOn() && !(await ctx.client.readContract({ address: arb, abi: arbAbi, functionName: "routers", args: [KYBER_ROUTER] }))) {
    await sender.call(tr("把聚合器加進白名單", "allow the aggregator router"), arb, "setRouter", [KYBER_ROUTER, true]);
  }
  console.log(describe(ctx, await readMarket(ctx), await readPosition(ctx, arb)));
  if (!CFG.closeOnly) await depositFlow(ctx, sender, arb, entry, wallet);
  saveState(state);
  return { ctx, sender, arb };
}

async function start() {
  checkConfig();
  const results = await Promise.allSettled(chains.map((c) => loadCtx(c)));
  const ctxs = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const failed = chains.filter((_, i) => results[i].status === "rejected");
  for (const [i, r] of results.entries()) {
    if (r.status === "rejected") console.log(tr(`[${chains[i].name}] 連不上（${errMsg(r.reason)}）`, `[${chains[i].name}] can't connect (${errMsg(r.reason)})`));
  }
  const account = await getAccount(ctxs);
  const owner = account.address;
  const key = owner.toLowerCase();
  const state = loadState();

  // 每條鏈各自設定；一條出錯（例如 RPC 被限流、存款失敗）不影響其他鏈。
  // 已經有合約的照樣讓機器人顧著；還沒有合約的，全自動模式在背景重試設定
  const plans: Plan[] = [];
  const retrySetup: Ctx[] = [];
  for (const ctx of ctxs) {
    try {
      plans.push(await setupChain(ctx, account, state));
    } catch (e) {
      console.log(tr(`[${ctx.chain.name}] 設定沒做完：${errMsg(e)}`, `[${ctx.chain.name}] setup didn't finish: ${errMsg(e)}`));
      const arb = state[key]?.[ctx.chain.key]?.arb;
      if (arb) plans.push({ ctx, arb, sender: new Sender(account, ctx) });
      else retrySetup.push(ctx);
    }
  }

  const trading: string[] = [];
  for (const p of plans) {
    if (!p.arb || !p.sender) continue;
    const pos = await readPosition(p.ctx, p.arb).catch(() => undefined);
    if (!pos || [...pos.collateral.values()].some((v) => v > 0n) || pos.debt > 0n || state[key]?.[p.ctx.chain.key]?.pendingDeposits) trading.push(p.ctx.chain.name);
  }
  const watching = plans.map((p) => p.ctx.chain.name).filter((n) => !trading.includes(n));
  const down = failed.map((c) => c.name);
  console.log(
    tr(
      `\n會自動交易：${trading.join("、") || "（沒有，合約裡都沒有本金）"}｜只監控：${watching.join("、") || "（無）"}${failed.length ? `｜連不上：${down.join("、")}` : ""}`,
      `\nTrading: ${trading.join(", ") || "(none, no capital in any contract)"} | Monitoring only: ${watching.join(", ") || "(none)"}${failed.length ? ` | Can't connect: ${down.join(", ")}` : ""}`,
    ),
  );
  const [openP, edge, hf, closeP, emHf] = [
    Number(CFG.openPremiumBps) / 100,
    Number(CFG.minEdgeBps) / 100,
    Number(CFG.targetHf) / 1e18,
    Number(CFG.closePremiumBps) / 100,
    Number(CFG.emergencyHf) / 1e18,
  ];
  console.log(
    tr(
      `門檻：溢價 ≥ ${openP}% 持續 ${CFG.confirmSeconds} 秒就開倉、賣到剩 ${edge}% 停、` +
        `HF 目標 ${hf}；溢價 ≤ ${closeP}% 平倉；HF < ${emHf} 緊急降槓桿` +
        (CFG.closeOnly ? "｜CLOSE_ONLY：只平倉、不開倉" : ""),
      `Thresholds: open when the premium is ≥ ${openP}% for ${CFG.confirmSeconds}s, stop selling at ${edge}% left, ` +
        `HF target ${hf}; close when the premium is ≤ ${closeP}%; emergency deleverage when HF < ${emHf}` +
        (CFG.closeOnly ? " | CLOSE_ONLY: close only, no new positions" : ""),
    ),
  );
  if (!(await confirm(tr("開始？", "Start?")))) return;
  console.log(tr("機器人開始跑，Ctrl+C 停止。停止後倉位還在，要出場就執行 node start.ts exit\n", "Bot is running, Ctrl+C to stop. The position stays open after stopping; to exit, run node start.ts exit\n"));

  const run = (p: Plan) => {
    const entry = state[key]?.[p.ctx.chain.key];
    return runBot({
      ctx: p.ctx,
      arb: p.arb,
      owner,
      sender: p.sender,
      pendingDeposits: entry?.pendingDeposits?.map((d) => ({ token: d.token, amount: BigInt(d.amount) })),
      onDeposited: (token) => {
        const e = state[key]?.[p.ctx.chain.key];
        if (e?.pendingDeposits) e.pendingDeposits = e.pendingDeposits.filter((d) => d.token !== token);
        if (e && !e.pendingDeposits?.length) delete e.pendingDeposits;
        saveState(state);
      },
    });
  };
  // 開機時連不上、或設定沒做完的鏈：全自動模式每分鐘重試，成功就開始顧（每條鏈只會有一個機器人）
  const later = [...failed.map((c) => ({ chain: c, ctx: undefined as Ctx | undefined })), ...retrySetup.map((ctx) => ({ chain: ctx.chain, ctx }))];
  if (later.length && YES) {
    for (const l of later) {
      (async () => {
        for (;;) {
          await new Promise((r) => setTimeout(r, 60_000));
          try {
            l.ctx ??= await loadCtx(l.chain);
            const plan = await setupChain(l.ctx, account, state);
            console.log(tr(`[${l.chain.name}] 設定好了，開始顧`, `[${l.chain.name}] set up, now running`));
            await run(plan);
          } catch (e) {
            console.log(tr(`[${l.chain.name}] 還沒好：${errMsg(e)}，一分鐘後再試`, `[${l.chain.name}] not ready yet: ${errMsg(e)}, retrying in a minute`));
          }
        }
      })();
    }
  } else if (later.length) {
    const names = later.map((l) => l.chain.name);
    console.log(tr(`${names.join("、")} 這次沒設定好，晚點重跑 node start.ts`, `${names.join(", ")} not set up this time, run node start.ts again later`));
  }
  await Promise.all(plans.map(run));
  if (later.length && YES) await new Promise(() => {}); // 全部鏈都在背景重試時，程式不能先結束
}

async function exit() {
  const ctxs = await loadCtxs();
  const account = await getAccount(ctxs);
  const targets: { ctx: Ctx; arb: Address }[] = [];
  for (const ctx of ctxs) {
    const arb = await findArb(ctx, account.address);
    if (!arb) continue;
    console.log(describe(ctx, await readMarket(ctx), await readPosition(ctx, arb)));
    targets.push({ ctx, arb });
  }
  if (targets.length === 0) {
    throw new Error(
      tr(
        "這個錢包在這幾條鏈上都沒有套利合約（state.json 裡找不到，也沒設 ARB_ADDRESS_<鏈>）",
        "This wallet has no arb contract on these chains (none in state.json, and ARB_ADDRESS_<chain> is not set)",
      ),
    );
  }
  const names = targets.map((t) => t.ctx.chain.name);
  if (!(await confirm(tr(`在 ${names.join("、")} 平倉，並把錢全部提回錢包？`, `Close the positions on ${names.join(", ")} and withdraw everything to the wallet?`)))) return;

  const state = loadState();
  const failed: string[] = [];
  for (const { ctx, arb } of targets) {
    try {
      await exitAll(ctx, arb, new Sender(account, ctx));
      delete state[account.address.toLowerCase()]?.[ctx.chain.key]?.pendingDeposits;
      const wallet = await walletOf(ctx, account.address);
      const coins = wallet.map((w) => `${formatUnits(w.bal, w.dec)} ${w.name}`);
      console.log(tr(`[${ctx.chain.name}] 完成。錢包現在有 ${coins.join("，")}`, `[${ctx.chain.name}] done. The wallet now has ${coins.join(", ")}`));
    } catch (e) {
      console.log(tr(`[${ctx.chain.name}] 沒做完：${errMsg(e)}`, `[${ctx.chain.name}] didn't finish: ${errMsg(e)}`));
      failed.push(ctx.chain.name);
    }
  }
  saveState(state);
  if (failed.length) {
    throw new Error(tr(`${failed.join("、")} 沒做完，看上面的原因，晚點再跑一次 node start.ts exit`, `${failed.join(", ")} didn't finish; see the reasons above and run node start.ts exit again later`));
  }
}

async function status() {
  const state = loadState();
  for (const ctx of await loadCtxs()) {
    const m = await readMarket(ctx);
    const k = ctx.chain.key;
    const fromEnv = process.env[`ARB_ADDRESS_${k.toUpperCase()}`] as Address | undefined;
    const arbs = fromEnv ? [fromEnv] : Object.values(state).flatMap((e) => (e[k] ? [e[k]!.arb] : []));
    if (arbs.length === 0) console.log(describe(ctx, m));
    for (const arb of arbs) {
      const code = await ctx.client.getCode({ address: arb });
      if (!code || code === "0x") {
        console.log(tr(`[${ctx.chain.name}] ${arb}：鏈上沒有這個合約`, `[${ctx.chain.name}] ${arb}: no such contract on chain`));
        continue;
      }
      const owner = await ctx.client.readContract({ address: arb, abi: arbAbi, functionName: "owner" });
      console.log(tr(`[${ctx.chain.name}] 合約 ${arb}（owner ${owner}）`, `[${ctx.chain.name}] contract ${arb} (owner ${owner})`));
      console.log(describe(ctx, m, await readPosition(ctx, arb)));
      for (const pd of state[owner.toLowerCase()]?.[k]?.pendingDeposits ?? []) {
        const [a, name] = [formatUnits(BigInt(pd.amount), ctx.decimals.get(pd.token)!), stableName(ctx, pd.token)];
        console.log(tr(`  等 Aave 能存時要存：${a} ${name}`, `  to deposit once Aave accepts it: ${a} ${name}`));
      }
    }
  }
}

async function check() {
  const json = args.includes("--json");
  const list: Finding[] = [];
  const results = await Promise.allSettled(chains.map((c) => loadCtx(c)));
  await Promise.all(
    results.map(async (r, i) => {
      const c = chains[i];
      try {
        if (r.status === "rejected") throw r.reason;
        const ctx = r.value;
        const m = await readMarket(ctx);
        const arb = await findArb(ctx);
        const p = arb ? await readPosition(ctx, arb) : undefined;
        if (!json) console.log(describe(ctx, m, p));
        list.push(...findings(ctx, m, p, botAlive(c.key), false, readHealth(c.key)));
      } catch (e) {
        list.push({ level: "warning", code: `rpc_error:${c.key}`, kind: "condition", message: tr(`${c.name} 讀不到資料：${errMsg(e)}`, `${c.name} can't read data: ${errMsg(e)}`) });
      }
    }),
  );
  // deploy/trader.sh 會寫 trader-status.json：機器人一直啟動失敗（例如 1Password 讀不到 key）時報出來
  const statusFile = fileURLToPath(new URL("trader-status.json", import.meta.url));
  if (existsSync(statusFile)) {
    const st = JSON.parse(readFileSync(statusFile, "utf8"));
    // 只看最近 15 分鐘內的：之後恢復正常、一直跑著的話，lastExit 會越來越舊，警示自己消失
    if (Number(st.consecutiveFailures) >= 3 && Date.now() - Date.parse(st.lastExit) < 15 * 60_000) {
      list.push({
        level: "critical",
        code: "trader_crashloop",
        kind: "condition",
        message: tr(
          `交易機器人連續 ${st.consecutiveFailures} 次啟動後很快就結束（最後一次 ${st.lastExit}，結束碼 ${st.lastCode}），看 trader.sh logs`,
          `the trading bot exited soon after starting ${st.consecutiveFailures} times in a row (last at ${st.lastExit}, exit code ${st.lastCode}), see trader.sh logs`,
        ),
      });
    }
  }
  // --state <檔案>：記住上一輪的 code，只回報變化（給排程用，沒變化就結束碼 0、不用通知）
  const statePath = flag("state");
  if (statePath) {
    const prev: string[] | undefined = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")).codes : undefined;
    const codes = list.map((f) => f.code);
    const added = codes.filter((c) => !prev?.includes(c));
    const resolved = (prev ?? []).filter((c) => !codes.includes(c));
    writeFileSync(statePath, `${JSON.stringify({ time: new Date().toISOString(), codes })}\n`);
    // 第一次跑只在有 warning／critical 時算變化
    const changed = prev ? added.length + resolved.length > 0 : list.some((f) => f.level !== "info");
    if (json) console.log(JSON.stringify({ changed, findings: list, new: added, resolved }));
    else {
      for (const f of list.filter((f) => added.includes(f.code))) console.log(tr(`  新：${f.level} ${f.code}：${f.message}`, `  new: ${f.level} ${f.code}: ${f.message}`));
      for (const c of resolved) console.log(tr(`  已恢復：${c}`, `  resolved: ${c}`));
    }
    process.exit(changed ? 1 : 0);
  }
  if (json) console.log(JSON.stringify(list));
  else for (const f of list) console.log(tr(`  ${f.level} ${f.code}：${f.message}`, `  ${f.level} ${f.code}: ${f.message}`));
  if (list.some((f) => f.level !== "info")) process.exit(1);
}

async function watch() {
  await Promise.all((await loadCtxs()).map((ctx) => runBot({ ctx })));
}

/// 印出錢包地址和各鏈的 ETH、穩定幣、合約（確認 key 讀得到；不送交易）
async function whoami() {
  const ctxs = await loadCtxs();
  const account = await getAccount(ctxs);
  for (const ctx of ctxs) {
    const [eth, wallet, arb] = await Promise.all([ctx.client.getBalance({ address: account.address }), walletOf(ctx, account.address), findArb(ctx, account.address)]);
    const [ethStr, coins] = [Number(formatEther(eth)).toFixed(5), wallet.map((w) => `${formatUnits(w.bal, w.dec)} ${w.name}`)];
    console.log(
      tr(
        `[${ctx.chain.name}] ETH ${ethStr}｜${coins.join("，")}｜合約 ${arb ?? "（還沒部署）"}`,
        `[${ctx.chain.name}] ETH ${ethStr} | ${coins.join(", ")} | contract ${arb ?? "(not deployed)"}`,
      ),
    );
  }
}

async function forget() {
  console.log(keychainDelete() ? tr("已刪掉鑰匙圈裡的 aave-u-eth", "Removed aave-u-eth from the Keychain") : tr("鑰匙圈裡沒有記住的錢包", "No wallet saved in the Keychain"));
}

const commands: Record<string, () => Promise<unknown>> = { start, exit, status, check, watch, forget, whoami };
if (!commands[cmd]) {
  console.log(tr("指令：start（預設）、exit、status、check、watch、forget、whoami", "Commands: start (default), exit, status, check, watch, forget, whoami"));
  process.exit(1);
}
commands[cmd]()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(tr(`\n錯誤：${(e as Error).message}`, `\nError: ${(e as Error).message}`));
    process.exit(1);
  });
