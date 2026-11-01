// Maintainer-only snapshot regeneration. No provider requests or credentials.
import { readFile, writeFile } from "node:fs/promises";
import { parseLiteLLM, priceUrl } from "../packages/usage/src/litellm.ts";
const response = await fetch(priceUrl, { redirect: "error", signal: AbortSignal.timeout(10000) });
if (!response.ok) throw new Error("LiteLLM download failed");
const snapshot = new URL("../packages/usage/src/prices.json", import.meta.url);
const { PriceTable } = await import("../packages/usage/src/settings.ts");
const existing = PriceTable.parse(JSON.parse(await readFile(snapshot, "utf8")));
const table = parseLiteLLM(
  await response.json(),
  new Date().toISOString().slice(0, 10),
  Object.keys(existing.models),
);
await writeFile(
  new URL("../packages/usage/src/prices.json", import.meta.url),
  `${JSON.stringify(table, null, 2)}\n`,
);
console.log(`Bundled ${Object.keys(table.models).length} LiteLLM token prices (${table.asOf})`);
