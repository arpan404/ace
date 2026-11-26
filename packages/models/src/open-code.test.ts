import { expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { normalizeOpenCodeV2 } from "./open-code.ts";
import { instance } from "./testing/support.ts";

// The catalog one real OpenCode 2.4.2 Location answers with (fixtures/opencode/2.4.2).
const sample = fileURLToPath(
  new URL("../../../fixtures/opencode/2.4.2/model-catalog.json", import.meta.url),
);

test("OpenCode 2.4.2 variants become efforts in the order the server lists them", async () => {
  const data: unknown = JSON.parse(await readFile(sample, "utf8"));
  const rows = normalizeOpenCodeV2(
    { location: { directory: process.cwd() }, data },
    instance("opencode"),
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  expect(byId.get("opencode/deepseek-v4.1-flash")).toMatchObject({
    contextWindow: 1000000,
    inputModalities: ["text", "image"],
    efforts: [
      { id: "low", level: "low", label: "Low" },
      { id: "high", level: "high", label: "High" },
      { id: "max", level: "max", label: "Max" },
    ],
  });
  expect(byId.get("opencode/gemini-4-neon")?.efforts.map((effort) => effort.id)).toEqual([
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  expect(byId.get("opencode/gemini-4-neon")?.efforts.at(-1)).toMatchObject({
    level: "xhigh",
    label: "XHigh",
  });
  expect(byId.get("opencode/hy4-flash-free")?.efforts).toMatchObject([
    { id: "none", level: "off", label: "Off" },
    { id: "high", level: "high", label: "High" },
  ]);
  expect(byId.get("opencode/kimi-k2.7-code")?.efforts).toEqual([]);
});
