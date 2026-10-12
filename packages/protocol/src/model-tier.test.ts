import { expect, test } from "vitest";
import { CatalogModel } from "./index.ts";

const row = (speed: string) => ({
  id: "gpt-5",
  displayName: "GPT-5",
  provider: "codex",
  instance: "codex-personal",
  nativeModelId: "gpt-5",
  reasoningEfforts: ["low", "high"],
  serviceTiers: [
    { id: "priority", name: "Fast", speed: "fast", parameters: { serviceTier: "priority" } },
    { id: "warp", name: "Warp", speed, parameters: { serviceTier: "warp" } },
  ],
  inputModalities: ["text"],
  isDefault: true,
  hidden: false,
  raw: { json: "{}", truncated: false },
});

test("a catalog row with a speed this reader doesn't know still reads, the speed kept as sent", () => {
  const parsed = CatalogModel.parse(row("hyperfast"));
  expect(parsed.serviceTiers.map((tier) => tier.speed)).toEqual(["fast", "hyperfast"]);
});
