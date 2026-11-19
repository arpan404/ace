import { expect, test } from "vitest";
import { setup } from "./test-support.ts";

test("inclusive Claude model estimates remain separate from additive root and child usage across reopen", () => {
  const h = setup();
  h.thread("thread", "claude");
  h.agent();
  h.agent("child", "root");
  h.usage(10, "root", { counterMode: "incremental", counterKey: "turn-1", usageScope: "agent" });
  h.usage(4, "child", {
    counterMode: "cumulative",
    counterKey: "child-counter",
    usageScope: "agent",
  });
  const snapshot = {
    usageScope: "model_session" as const,
    model: "sonnet",
    counterKey: "native:initial",
    counterMode: "cumulative" as const,
    costUsd: 3,
  };
  h.usage(100, "root", snapshot);
  h.usage(100, "root", snapshot);
  h.reopen();
  h.usage(110, "root", { ...snapshot, costUsd: 3.1 });
  h.usage(0, "root", { ...snapshot, costUsd: 0 });
  expect(h.totals()).toMatchObject({ inputTokens: 14, providerReportedUsd: 0 });
  expect(h.store.sessionTotalsFor({ thread: "thread" })).toMatchObject([
    { inputTokens: 110, costUsd: 3.1, model: "sonnet" },
  ]);
  h.usage(5, "root", { ...snapshot, counterKey: "native:clear", costUsd: 0.1 });
  expect(
    h.store
      .sessionTotalsFor({ thread: "thread" })
      .map((r) => r.inputTokens)
      .toSorted((a, b) => a - b),
  ).toEqual([5, 110]);
  h.send({ type: "thread.deleted" });
  expect(h.store.sessionTotalsFor({ thread: "thread" })).toEqual([]);
});

test("fork inherited inclusive totals do not add spend to the fork's fresh main-loop samples", () => {
  const h = setup();
  h.thread("source", "claude");
  h.thread("fork", "claude");
  h.agent("source-root", null, "sonnet", "claude", "source");
  h.agent("fork-root", null, "sonnet", "claude", "fork");
  for (const [threadId, agentId] of [
    ["source", "source-root"],
    ["fork", "fork-root"],
  ])
    h.send(
      {
        type: "usage.updated",
        agentId: agentId ?? "",
        inputTokens: 300,
        outputTokens: 20,
        usageScope: "model_session",
        model: "sonnet",
        counterKey: `${threadId}:initial`,
        costUsd: 1,
      },
      undefined,
      threadId,
    );
  h.send(
    {
      type: "usage.updated",
      agentId: "fork-root",
      inputTokens: 7,
      outputTokens: 2,
      counterMode: "incremental",
      counterKey: "new-fork-turn",
    },
    undefined,
    "fork",
  );
  expect(h.totals()).toMatchObject({ inputTokens: 7, outputTokens: 2, providerReportedUsd: 0 });
  expect(h.store.sessionTotalsFor({ thread: "source" })[0]?.inputTokens).toBe(300);
  expect(h.store.sessionTotalsFor({ thread: "fork" })[0]?.inputTokens).toBe(300);
});
