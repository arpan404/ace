import { expect, it } from "vitest";
import { setup } from "./translator.test-helper.ts";

it("token reports retain cumulative totals and reasoning while occupancy uses the last sample", () => {
  const h = setup();
  h.start();
  h.recv("thread/tokenUsage/updated", {
    threadId: "native",
    tokenUsage: {
      total: {
        inputTokens: 1000,
        outputTokens: 50,
        cachedInputTokens: 400,
        reasoningOutputTokens: 20,
      },
      last: { inputTokens: 100, outputTokens: 5, totalTokens: 105 },
    },
  });
  h.recv("thread/tokenUsage/updated", {
    threadId: "native",
    tokenUsage: {
      total: {
        inputTokens: 1200,
        outputTokens: 70,
        cachedInputTokens: 450,
        reasoningOutputTokens: 30,
      },
      last: { inputTokens: 200, outputTokens: 20, totalTokens: 220 },
    },
  });
  const usage = h.events.filter((e) => e.type === "usage.updated");
  expect(usage).toMatchObject([
    {
      inputTokens: 1000,
      outputTokens: 50,
      reasoningTokens: 20,
      counterMode: "cumulative",
      counterKey: "codex:native",
    },
    {
      inputTokens: 1200,
      outputTokens: 70,
      reasoningTokens: 30,
      counterMode: "cumulative",
      counterKey: "codex:native",
    },
  ]);
  expect(h.events.findLast((e) => e.type === "context.sampled")).toMatchObject({
    usedTokens: 220,
  });
});
