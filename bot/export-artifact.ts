// forge build 之後，把合約的 ABI 和 bytecode 匯出成 bot/OracleLagArb.json，start.ts 部署時用它。
// 一起記下 src/ 的 sha256；合約改過卻沒重新匯出，start.ts 會拒絕部署。
//   node export-artifact.ts [forge 輸出的 OracleLagArb.json，預設 ../out/OracleLagArb.sol/OracleLagArb.json]
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const input = process.argv[2] ?? new URL("../out/OracleLagArb.sol/OracleLagArb.json", import.meta.url);
const forge = JSON.parse(readFileSync(input, "utf8"));
const h = createHash("sha256");
for (const p of ["../src/OracleLagArb.sol", "../src/interfaces/External.sol"]) h.update(readFileSync(new URL(p, import.meta.url)));

const out = {
  compiler: forge.metadata?.compiler?.version,
  sourceHash: h.digest("hex"),
  abi: forge.abi,
  bytecode: forge.bytecode.object,
};
writeFileSync(new URL("OracleLagArb.json", import.meta.url), `${JSON.stringify(out, null, 1)}\n`);
console.log(`OracleLagArb.json：solc ${out.compiler}，bytecode ${(out.bytecode.length - 2) / 2} bytes，sourceHash ${out.sourceHash.slice(0, 12)}…`);
