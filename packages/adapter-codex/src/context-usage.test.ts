import { expect, test } from "vitest";
import { setup } from "./translator.test-helper.ts";
test("Codex occupancy uses the last context sample rather than lifetime billing totals", () => {
  const h = setup();
  h.start();
  h.recv("thread/tokenUsage/updated", {
    threadId: "native",
    tokenUsage: {
      total: { totalTokens: 900000 },
      last: { totalTokens: 12345, inputTokens: 12000, outputTokens: 345, cachedInputTokens: 10000 },
      modelContextWindow: 128000,
    },
  });
  expect(h.events.filter((event) => event.type === "context.sampled")).toEqual([
    expect.objectContaining({ usedTokens: 12345, windowTokens: 128000, sessionId: "native" }),
  ]);
  h.item({ id: "compact", type: "contextCompaction" }, true);
  expect(
    h.events.some((event) => event.type === "item.created" && event.item.type === "compaction"),
  ).toBe(true);
});
test("Codex missing last usage does not claim a zero occupancy", () => {
  const h = setup();
  h.recv("thread/tokenUsage/updated", {
    threadId: "native",
    tokenUsage: { total: { totalTokens: 50000 }, last: { future: true } },
  });
  expect(h.events.some((event) => event.type === "context.sampled")).toBe(false);
});

test("Codex terminal quota errors are limited while overloaded upstream retries remain waiting", () => {
  const quota = setup();
  quota.start();
  quota.recv("error", {
    threadId: "native",
    error: { codexErrorInfo: "usageLimitExceeded", message: "Allowance exhausted" },
    willRetry: false,
  });
  expect(quota.state.status.state).toBe("limited");
  const overloaded = setup();
  overloaded.start();
  overloaded.recv("error", {
    threadId: "native",
    error: { codexErrorInfo: "serverOverloaded", message: "Busy" },
    willRetry: true,
  });
  expect(overloaded.state.status).toEqual({ state: "waiting", on: "upstream" });
});
