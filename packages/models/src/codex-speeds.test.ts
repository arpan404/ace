import { expect, test } from "vitest";
import { normalizeCodex } from "./index.ts";
import { codexPayload, instance } from "./testing/support.ts";

test("Codex's priority and ultrafast tiers become Fast and Ultrafast, and flex no speed", () => {
  const payload = codexPayload("gpt-5");
  const native = payload.data[0];
  if (!native) throw new Error("no model");
  native.serviceTiers = [
    { id: "flex", name: "Flex", description: "Slower and cheaper" },
    { id: "priority", name: "Fast", description: "Fast tier" },
    { id: "ultrafast", name: "Ultrafast", description: "Fastest tier" },
  ];
  const [model] = normalizeCodex(payload, instance());
  expect(
    model?.serviceTiers.map((tier) => [tier.id, tier.speed, tier.parameters["serviceTier"]]),
  ).toEqual([
    ["flex", undefined, "flex"],
    ["priority", "fast", "priority"],
    ["ultrafast", "ultrafast", "ultrafast"],
  ]);
});
