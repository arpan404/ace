import { expect, test } from "vitest";
import { degradedPatch } from "./degraded-patch.ts";

test("a message row native rejected retries without its bubble, the part that may carry the bad text", () => {
  const patch = {
    type: "thread.item",
    id: "ask",
    row: {
      id: "ask",
      type: "message",
      role: "user",
      text: "\udc00b",
      bubble: { segments: [{ kind: "text", text: "\udc00b", mention: "" }] },
    },
  };
  const row = degradedPatch(patch).row as Record<string, unknown>;
  expect(row.bubble).toBeNull();
  expect(row.id).toBe("ask");
  expect(JSON.stringify(row).includes("\\udc00")).toBe(false);
});
