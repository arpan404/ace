// Maintainer-only: fills the prices Spade's preset models lack in spade/config/models.json from
// LiteLLM's public list, matched the way ace's usage prices are (ADR 0040). A price someone wrote
// by hand is kept. No provider requests or credentials. Run, then `bunx oxfmt spade/config/models.json`.
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { matchModel, parseLiteLLM, priceUrl } from "../packages/usage/src/litellm.ts";

const Preset = z
  .object({
    endpoints: z.array(
      z
        .object({
          id: z.string(),
          models: z.array(
            z.object({ id: z.string(), price: z.unknown().optional() }).passthrough(),
          ),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const file = new URL("../spade/config/models.json", import.meta.url);
// Checked, then edited as read, so the file keeps its own order.
const raw: unknown = JSON.parse(await readFile(file, "utf8"));
Preset.parse(raw);
const presets = raw as z.infer<typeof Preset>;
const response = await fetch(priceUrl, { redirect: "error", signal: AbortSignal.timeout(10000) });
if (!response.ok) throw new Error("LiteLLM download failed");
const entries = z.record(z.string(), z.unknown()).parse(await response.json());
const date = new Date().toISOString().slice(0, 10);
const round = (perMillion: number) => Math.round(perMillion * 1e6) / 1e6;

let filled = 0;
const unpriced: string[] = [];
for (const endpoint of presets.endpoints) {
  for (const model of endpoint.models) {
    if (model.price !== undefined) continue;
    const reference = `${endpoint.id}/${model.id}`;
    const key = matchModel(reference, entries);
    const rate =
      key === undefined ? undefined : parseLiteLLM({ [key]: entries[key] }, date).models[key];
    if (rate === undefined) {
      unpriced.push(reference);
      continue;
    }
    model.price = {
      input: round(rate.input),
      output: round(rate.output),
      cache_read: round(rate.cached),
      cache_write: round(rate.write),
    };
    filled += 1;
  }
}
await writeFile(file, `${layout(presets, "")}\n`);
console.log(`Filled ${filled} preset prices from LiteLLM (${date}).`);
if (unpriced.length) console.log(`No LiteLLM price: ${unpriced.join(", ")}`);

/** JSON as the file is laid out: an object or list that fits on one line stays on one. */
function layout(value: unknown, indent: string): string {
  const inline = oneLine(value);
  if (inline.length + indent.length <= 96 || value === null || typeof value !== "object")
    return inline;
  const inner = `${indent}  `;
  if (Array.isArray(value))
    return `[\n${value.map((item) => inner + layout(item, inner)).join(",\n")}\n${indent}]`;
  const fields = Object.entries(value).map(
    ([key, item]) => `${inner}${JSON.stringify(key)}: ${layout(item, inner)}`,
  );
  return `{\n${fields.join(",\n")}\n${indent}}`;
}

function oneLine(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(oneLine).join(", ")}]`;
  const fields = Object.entries(value).map(
    ([key, item]) => `${JSON.stringify(key)}: ${oneLine(item)}`,
  );
  return fields.length ? `{ ${fields.join(", ")} }` : "{}";
}
