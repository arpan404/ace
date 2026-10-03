import { expect, it } from "vitest";
import { harness } from "./test-helper.ts";
it("usage metadata reaches canonical events without changing agent status", () => {
  const h = harness();
  h.see();
  const events = h.send({
    type: "usage",
    agent: "root",
    inputTokens: 20,
    outputTokens: 5,
    reasoningTokens: 2,
    cachedInputTokens: 4,
    cacheWriteTokens: 3,
    cacheWrite1hTokens: 1,
    model: "model",
    accountId: "account",
    billingMode: "subscription",
    counterMode: "cumulative",
    counterKey: "session:message",
  });
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "usage.updated",
      inputTokens: 20,
      outputTokens: 5,
      cachedInputTokens: 4,
      model: "model",
      reasoningTokens: 2,
      cacheWriteTokens: 3,
      cacheWrite1hTokens: 1,
      accountId: "account",
      billingMode: "subscription",
      counterMode: "cumulative",
      counterKey: "session:message",
    }),
  );
  expect(events.some((e) => e.type === "agent.status")).toBe(false);
});
