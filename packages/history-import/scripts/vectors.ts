/**
 * Regenerates `native/history/vectors/` from the TypeScript (ADR 0206): the wire frames both
 * sides must read and write, and the text rules shared with live code. `--check` fails instead
 * of writing when a vector file is stale.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { historyVectors } from "../src/rust/vectors.ts";

const root = fileURLToPath(new URL("../../../native/history/vectors/", import.meta.url));
const check = process.argv.includes("--check");
let stale = 0;
for (const [name, content] of Object.entries(historyVectors())) {
  const path = root + name;
  const text = JSON.stringify(content, null, 2) + "\n";
  const current = await readFile(path, "utf8").catch(() => "");
  if (current === text) continue;
  if (check) {
    stale++;
    console.error(`stale: ${path}`);
  } else await writeFile(path, text);
}
if (stale) process.exit(1);
