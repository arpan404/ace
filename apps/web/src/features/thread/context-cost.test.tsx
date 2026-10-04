import { replayCursor, type UsageSessionTotal, type UsageSource } from "@ace/fake-daemon";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

const threadId = "thread-replay-cursor";

/** The thread's own usage: the same tokens every day, on Claude's subscription. */
const usage: UsageSource = {
  provider: "claude",
  account: "claude-personal",
  model: "claude-opus-4-6",
  daily: 80_000,
  steady: true,
  apiUsdPerMillion: 15,
  billing: "subscription",
  threads: [threadId],
};

function snapshot(
  scope: UsageSessionTotal["scope"],
  model: string,
  costUsd: number,
): UsageSessionTotal {
  return {
    counterKey: "claude:replay:initial",
    scope,
    model,
    at: Date.now(),
    inputTokens: 40_000,
    outputTokens: 2_000,
    cachedInputTokens: 30_000,
    cacheWriteTokens: 4_000,
    cacheWrite1hTokens: 0,
    costUsd,
  };
}

/** The thread open, with a context sample from the provider, and the meter's tooltip showing. */
async function hoverMeter(stage: { source: UsageSource; sessions: UsageSessionTotal[] }) {
  const app = harness();
  app.daemon.services.usage.sources = [stage.source];
  app.daemon.services.usage.sessions = { [threadId]: stage.sessions };
  app.play(replayCursor()).runThrough("finding");
  await app.open(`/t/${threadId}`);
  await screen.findByRole("combobox", { name: "Message" });
  app.daemon.apply(threadId, [
    {
      type: "context.sample",
      agent: "root",
      usedTokens: 168_000,
      windowTokens: 200_000,
      model: "claude-opus-4-6",
    },
  ]);
  await userEvent.hover(await screen.findByRole("meter", { name: "Context used" }));
  return screen.findByRole("tooltip");
}

test("the context meter names the model and what Claude reported the thread cost", async () => {
  const tip = await hoverMeter({
    source: usage,
    sessions: [
      snapshot("provider_session", "", 0.081),
      snapshot("model_session", "claude-opus-4-6", 0.06),
      snapshot("model_session", "claude-haiku-4-5", 0.021),
    ],
  });

  expect(tip.textContent).toContain("Opus 4.6 · 168,000 of 200,000 tokens in context");
  // A year of 100K tokens a day; the session counts once, not again with its model totals.
  expect(
    await screen.findByText("Past year: 36.5M tokens · $0.08 reported", {}, { timeout: 2000 }),
  ).toBeTruthy();
});

test("a thread nothing reported a cost for, and with no API prices, says its cost is unavailable", async () => {
  await hoverMeter({ source: { ...usage, apiUsdPerMillion: null }, sessions: [] });

  expect(
    await screen.findByText("Past year: 36.5M tokens · cost unavailable", {}, { timeout: 2000 }),
  ).toBeTruthy();
});
