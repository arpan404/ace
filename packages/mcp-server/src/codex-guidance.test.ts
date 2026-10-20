import { expect, it } from "vitest";
import { compactToolNames } from "./codex-guidance.ts";

it("folds three or more tools sharing a family prefix into one brace group, in catalogue order", () => {
  expect(
    compactToolNames([
      "context",
      "mcp__ace__browser_open",
      "browser_snapshot",
      "thread_read",
      "browser_act",
      "thread_start",
    ]),
  ).toBe("context, browser_{open,snapshot,act}, thread_read, thread_start");
});

it("a name list longer than its cap ends at a whole entry and says it was cut", () => {
  const names = Array.from({ length: 40 }, (_, index) => `tool${index}`);
  const text = compactToolNames(names, 60);
  expect(text.length).toBeLessThanOrEqual(63);
  expect(text.endsWith(", …")).toBe(true);
  for (const entry of text.slice(0, -3).split(", ")) expect(names).toContain(entry);
});
