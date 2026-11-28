import { expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { discoverOpenCodeModels } from "./index.ts";
import { setup } from "./testing/v2-session.ts";

// The catalog one real OpenCode 2.4.2 Location answers with (fixtures/opencode/2.4.2).
const sample = fileURLToPath(
  new URL("../../../fixtures/opencode/2.4.2/model-catalog.json", import.meta.url),
);
const Catalog = z.object({
  data: z.array(z.object({ modelID: z.string(), variants: z.array(z.object({ id: z.string() })) })),
});

test("discovery reads a cold 2.4.2 catalog again until its variants arrive", async () => {
  const h = await setup({
    discovery: { env: { ACE_TEST_CATALOG_FILE: sample, ACE_TEST_COLD_MODELS: "2" } },
  });
  const payload = await discoverOpenCodeModels(h.options, "/one", new AbortController().signal);
  const catalog = Catalog.parse(payload);
  const variants = (modelID: string) =>
    catalog.data.find((model) => model.modelID === modelID)?.variants.map((variant) => variant.id);
  expect(catalog.data.map((model) => model.modelID)).toEqual([
    "deepseek-v4.1-flash",
    "gemini-4-neon",
    "hy4-flash-free",
    "kimi-k2.7-code",
  ]);
  expect(variants("deepseek-v4.1-flash")).toEqual(["low", "high", "max"]);
  expect(variants("gemini-4-neon")).toEqual(["low", "medium", "high", "xhigh"]);
  expect(variants("kimi-k2.7-code")).toEqual([]);
});
