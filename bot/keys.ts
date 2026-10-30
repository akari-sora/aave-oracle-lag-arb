// 把使用者給的東西變成錢包。接受：
//   私鑰           有沒有 0x、前後空白、引號都可以
//   助記詞         12～24 個字；換行、逗號、編號（1. 2) 3、）、大小寫都可以；英文、簡繁中文、日韓西法義捷葡單字表；
//                  中文可以不留空格。拼錯會提示最接近的字，檢查碼不對會擋下來
//   keystore 檔    JSON 檔路徑（MetaMask 匯出、geth、`cast wallet import` 都是這個格式），再問密碼
//   Foundry 帳戶   foundry:<名稱>，讀 ~/.foundry/keystores/<名稱>
//   1Password      op://vault/item/field，用 `op read` 讀
//   macOS 鑰匙圈   之前選擇記住的話，下次直接用
import { execFileSync } from "node:child_process";
import { createDecipheriv, createHash, pbkdf2Sync, scryptSync } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { concat, keccak256, toHex, type Hex, type LocalAccount } from "viem";
import {
  czech,
  english,
  french,
  italian,
  japanese,
  korean,
  mnemonicToAccount,
  portuguese,
  privateKeyToAccount,
  simplifiedChinese,
  spanish,
  traditionalChinese,
} from "viem/accounts";
import { tr } from "./i18n.ts";

// [中文名, 英文名, 單字表]；名稱只在印出來時用 tr 挑
const WORDLISTS: [string, string, string[]][] = [
  ["英文", "English", english],
  ["簡體中文", "Simplified Chinese", simplifiedChinese],
  ["繁體中文", "Traditional Chinese", traditionalChinese],
  ["日文", "Japanese", japanese],
  ["韓文", "Korean", korean],
  ["西班牙文", "Spanish", spanish],
  ["法文", "French", french],
  ["義大利文", "Italian", italian],
  ["捷克文", "Czech", czech],
  ["葡萄牙文", "Portuguese", portuguese],
];

export type Secret = { kind: "privateKey"; key: Hex; source: string } | { kind: "mnemonic"; phrase: string; language: string; source: string };

/// 終端機貼上時夾帶的控制碼（ESC[200~ 之類）、引號、多餘空白
export const cleanInput = (s: string) =>
  s
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();

/// askPassword：keystore 需要密碼時用
export async function parseSecret(raw: string, askPassword: (q: string) => Promise<string>): Promise<Secret> {
  const input = cleanInput(raw);
  if (!input) throw new Error(tr("沒有輸入", "No input"));

  if (input.startsWith("op://")) {
    let value: string;
    try {
      // 加逾時：op 卡住（網路、token 失效）時不能讓機器人一直卡在啟動
      value = execFileSync("op", ["read", input], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
    } catch (e) {
      const detail = String((e as { stderr?: string }).stderr ?? e).trim();
      throw new Error(tr(`1Password 讀不到 ${input}：${detail}`, `1Password can't read ${input}: ${detail}`));
    }
    const s = await parseSecret(value, askPassword);
    return { ...s, source: input };
  }

  const keystorePath = input.startsWith("foundry:")
    ? join(homedir(), ".foundry", "keystores", input.slice("foundry:".length))
    : input.replace(/^~(?=\/)/, homedir());
  if (!input.includes(" ") && existsSync(keystorePath) && statSync(keystorePath).isFile()) {
    const json = JSON.parse(readFileSync(keystorePath, "utf8"));
    const password = await askPassword(tr(`keystore 密碼（${keystorePath}）：`, `keystore password (${keystorePath}): `));
    return { kind: "privateKey", key: decryptKeystore(json, password), source: keystorePath };
  }
  if (input.startsWith("foundry:")) throw new Error(tr(`找不到 Foundry 帳戶 ${keystorePath}`, `Foundry account not found: ${keystorePath}`));

  const hex = input.replace(/\s+/g, "").replace(/^0x/i, "");
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return { kind: "privateKey", key: `0x${hex.toLowerCase()}`, source: "私鑰" };
  if (/^[0-9a-fA-F]{60,70}$/.test(hex)) throw new Error(
      tr(
        `私鑰應該是 64 個十六進位字元，這裡有 ${hex.length} 個，可能少複製或多複製了`,
        `A private key is 64 hex characters, this one has ${hex.length}; part of it may be missing or extra`,
      ),
    );

  const { phrase, language } = normalizeMnemonic(input);
  return { kind: "mnemonic", phrase, language, source: "助記詞" };
}

// ───────────────────────────── 助記詞 ─────────────────────────────

function normalizeMnemonic(input: string): { phrase: string; language: string } {
  let text = input.normalize("NFKD").toLowerCase();
  // 中文助記詞常常連在一起寫：沒有空白而且全是 CJK 字元時，一個字一個詞
  const compact = text.replace(/[\s,，、.。;；]+/g, "");
  if (!/\s/.test(text.trim()) && /^[㐀-鿿]+$/.test(compact.normalize("NFC"))) text = [...compact.normalize("NFC")].join(" ");
  const words = text
    .split(/[\s,，、;；]+/)
    .map((w) => w.replace(/^\(?\d+[.)、:：]?\)?/, "").replace(/[.。]$/, "")) // 去掉「1.」「2)」「3、」這類編號
    .filter((w) => w && !/^\d+$/.test(w));

  if (![12, 15, 18, 21, 24].includes(words.length)) {
    const head = words.slice(0, 3).join(" ");
    throw new Error(
      tr(
        `助記詞應該是 12、15、18、21 或 24 個字，這裡讀到 ${words.length} 個${words.length ? `（${head} …）` : ""}`,
        `A mnemonic should be 12, 15, 18, 21 or 24 words, got ${words.length}${words.length ? ` (${head} …)` : ""}`,
      ),
    );
  }

  const norm = (list: string[]) => list.map((w) => w.normalize("NFKD"));
  // 簡繁中文有很多字重疊，檢查碼要每張單字表都試過才算錯
  let allWordsKnown = false;
  for (const [language, en, list] of WORDLISTS) {
    const nl = norm(list);
    const index = words.map((w) => nl.indexOf(w));
    if (!index.every((i) => i >= 0)) continue;
    allWordsKnown = true;
    if (checksumOk(index)) return { phrase: words.map((_, j) => list[index[j]]).join(language === "日文" ? "　" : " "), language: tr(language, en) };
  }
  if (allWordsKnown) {
    throw new Error(
      tr(
        "助記詞每個字都對，但檢查碼不對：可能有字的順序錯了、或抄錯成另一個也在單字表裡的字",
        "Every word is in the wordlist but the checksum is wrong: some words may be out of order, or one was miscopied as another valid word",
      ),
    );
  }

  // 找最多字對得上的單字表，列出拼錯的字和最接近的建議
  const [language, list] = WORDLISTS.map(([l, en, li]) => [tr(l, en), norm(li)] as const).sort(
    (a, b) => words.filter((w) => b[1].includes(w)).length - words.filter((w) => a[1].includes(w)).length,
  )[0];
  const wrong = words.flatMap((w, i) => {
    if (list.includes(w)) return [];
    const c = closest(w, list);
    return [tr(`第 ${i + 1} 個字「${w}」→ 是不是「${c}」？`, `word ${i + 1} "${w}" → did you mean "${c}"?`)];
  });
  throw new Error(
    tr(
      `助記詞（${language}）有 ${wrong.length} 個字不在單字表：\n  ${wrong.join("\n  ")}`,
      `Mnemonic (${language}) has ${wrong.length} word(s) not in the wordlist:\n  ${wrong.join("\n  ")}`,
    ),
  );
}

/// BIP39：每個字 11 bits，最後 ENT/32 bits 是 sha256(entropy) 的前幾位
function checksumOk(index: number[]): boolean {
  const bits = index.map((i) => i.toString(2).padStart(11, "0")).join("");
  const csLen = bits.length / 33;
  const entBits = bits.slice(0, bits.length - csLen);
  const entropy = Buffer.from(entBits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const hash = createHash("sha256").update(entropy).digest();
  const expected = [...hash].map((b) => b.toString(2).padStart(8, "0")).join("").slice(0, csLen);
  return expected === bits.slice(bits.length - csLen);
}

function closest(word: string, list: string[]): string {
  let best = list[0];
  let bestD = Infinity;
  for (const w of list) {
    const d = levenshtein(word, w);
    if (d < bestD) [best, bestD] = [w, d];
  }
  return best;
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/// 同一組助記詞常見的地址：MetaMask／Rabby／大部分錢包是 m/44'/60'/0'/0/i，Ledger Live 是 m/44'/60'/i'/0/0
export function candidatePaths(): { label: string; path: `m/44'/60'/${string}` }[] {
  const out: { label: string; path: `m/44'/60'/${string}` }[] = [];
  for (let i = 0; i < 5; i++) out.push({ label: `MetaMask #${i}`, path: `m/44'/60'/0'/0/${i}` });
  for (let i = 1; i < 3; i++) out.push({ label: `Ledger Live #${i}`, path: `m/44'/60'/${i}'/0/0` });
  return out;
}

export function accountFor(s: Secret, path?: `m/44'/60'/${string}`): LocalAccount {
  return s.kind === "privateKey" ? privateKeyToAccount(s.key) : mnemonicToAccount(s.phrase, { path: path ?? "m/44'/60'/0'/0/0" });
}

// ───────────────────────────── keystore ─────────────────────────────

/// Web3 Secret Storage v3（scrypt 或 pbkdf2 + aes-128-ctr，MAC 是 keccak256(key[16..32] ‖ ciphertext)）
export function decryptKeystore(json: any, password: string): Hex {
  const c = json.crypto ?? json.Crypto;
  if (!c || c.cipher !== "aes-128-ctr") throw new Error(tr("看不懂這個 keystore 檔（不是 v3 格式）", "Can't read this keystore file (not v3 format)"));
  const p = c.kdfparams;
  const salt = Buffer.from(p.salt, "hex");
  let key: Buffer;
  if (c.kdf === "scrypt") key = scryptSync(password, salt, p.dklen, { N: p.n, r: p.r, p: p.p, maxmem: 256 * p.n * p.r * p.p + 1024 * 1024 });
  else if (c.kdf === "pbkdf2") key = pbkdf2Sync(password, salt, p.c, p.dklen, "sha256");
  else throw new Error(tr(`不支援的 kdf：${c.kdf}`, `Unsupported kdf: ${c.kdf}`));
  const ciphertext = Buffer.from(c.ciphertext, "hex");
  const mac = keccak256(concat([toHex(key.subarray(16, 32)), toHex(ciphertext)]));
  if (mac.slice(2) !== String(c.mac).toLowerCase().replace(/^0x/, "")) throw new Error(tr("keystore 密碼不對", "Wrong keystore password"));
  const decipher = createDecipheriv("aes-128-ctr", key.subarray(0, 16), Buffer.from(c.cipherparams.iv, "hex"));
  return toHex(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
}

// ───────────────────────────── macOS 鑰匙圈 ─────────────────────────────
// 服務名稱 aave-u-eth，帳號欄位放錢包地址。寫入時 key 從 stdin 給 `security -i`，不會出現在指令列參數裡

const SERVICE = "aave-u-eth";
export const keychainAvailable = () => platform() === "darwin";

export function keychainLoad(): { address: string; secret: string } | undefined {
  if (!keychainAvailable()) return undefined;
  try {
    const attrs = execFileSync("security", ["find-generic-password", "-s", SERVICE], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const address = attrs.match(/"acct"<blob>="([^"]+)"/)?.[1];
    const secret = execFileSync("security", ["find-generic-password", "-s", SERVICE, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return address && secret ? { address, secret } : undefined;
  } catch {
    return undefined;
  }
}

export function keychainSave(address: string, secret: string) {
  const quoted = `"${secret.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  execFileSync("security", ["-i"], { input: `add-generic-password -U -s ${SERVICE} -a ${address} -w ${quoted}\n`, stdio: ["pipe", "ignore", "pipe"] });
}

export function keychainDelete(): boolean {
  if (!keychainAvailable()) return false;
  try {
    execFileSync("security", ["delete-generic-password", "-s", SERVICE], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
