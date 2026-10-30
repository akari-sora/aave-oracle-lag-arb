// 介面語言：BOT_LANG=en 用英文，沒設或其他值都是繁體中文（不看 LANG／LC_*，很多 Linux 預設 LANG=en_US）。
// 每次呼叫才讀環境變數：bot/.env 是 core.ts 在 import 完之後才載入的，寫在 .env 裡的 BOT_LANG 也要算數。
// 所以不要在模組最上層（例如 CFG、WORDLISTS）呼叫 tr。
export const lang = (): "zh-TW" | "en" => (process.env.BOT_LANG === "en" ? "en" : "zh-TW");
export const tr = (zh: string, en: string): string => (lang() === "en" ? en : zh);
