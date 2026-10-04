import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, createThreadState } from "@ace/core";
import { createTranslator } from "@ace/adapter-claude";
import { createOpenCodeAdapter } from "@ace/adapter-opencode";
import { UsageStore, compactEvent, type UsageEvent } from "@ace/usage";
import { Event, ThreadId } from "@ace/protocol";

test("Claude native result costs remain readable separately from additive usage with its actual model", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-provider-usage-"));
  const store = new UsageStore(join(home, "usage.sqlite"));
  const state = createThreadState({
    threadId: ThreadId.parse("thread"),
    config: { provider: "claude", silenceMs: 60000 },
  });
  const translator = createTranslator({ rootKey: "root" });
  let seq = 1,
    identity = 0;
  const at = Date.parse("2026-10-04T12:00:00Z");
  const events: UsageEvent[] = [
    {
      seq,
      at,
      threadId: "thread",
      payload: { type: "thread.created", provider: "claude", workspace: "workspace" },
    },
  ];
  for (const [index, data] of [
    { type: "system", subtype: "init", session_id: "session", cwd: home },
    {
      type: "assistant",
      message: {
        id: "m",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "reply" }],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    },
    {
      type: "result",
      uuid: "result",
      is_error: false,
      usage: { input_tokens: 10, output_tokens: 2 },
      total_cost_usd: 0.081,
      modelUsage: {
        "claude-sonnet-4-6": {
          inputTokens: 10,
          outputTokens: 2,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.081,
          contextWindow: 200000,
        },
      },
    },
  ].entries()) {
    for (const fact of translator.translate(
      { seq: index, t: index, dir: "recv", channel: "sdk", data },
      at,
    )) {
      for (const payload of apply(state, fact, {
        now: at,
        ids: { next: (kind) => `${kind}-${++identity}` },
      })) {
        const compact = compactEvent(
          Event.parse({ id: `event-${++seq}`, seq, threadId: "thread", at, payload }),
        );
        if (compact) events.push(compact);
      }
    }
    translator.takeDiagnostics?.();
  }
  try {
    store.ingest({ afterSeq: 0, throughSeq: seq, events });
    const rows = store.summary({ from: "2026-10-04", to: "2026-10-04", groupBy: ["model"] }).rows;
    expect(rows).toMatchObject([
      { dimensions: { model: "claude-sonnet-4-6" }, totals: { inputTokens: 10, outputTokens: 2 } },
    ]);
    expect(store.sessionTotalsFor({ thread: "thread" })).toMatchObject([
      { scope: "model_session", model: "claude-sonnet-4-6", costUsd: 0.081 },
      { scope: "provider_session", model: "", costUsd: 0.081 },
    ]);
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

const model = (id: string) => ({ providerID: "local", id });

// Mutations 9, 10, 18: sum occupancy, drop caches, retain model A or reset cumulative
// baseline on model selection. Not executed (tests run at merge).
test("OpenCode cumulative billing spans a model switch without billing A's history to B", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-opencode-usage-"));
  const store = new UsageStore(join(home, "usage.sqlite"));
  const threadId = ThreadId.parse("switch");
  const state = createThreadState({ threadId, config: { provider: "opencode", silenceMs: 60000 } });
  const translator = createOpenCodeAdapter().createTranslator({ threadId, rootKey: "root" });
  let seq = 1,
    identity = 0;
  const at = Date.parse("2026-10-04T12:00:00Z");
  const events: UsageEvent[] = [
    {
      seq,
      at,
      threadId,
      payload: { type: "thread.created", provider: "opencode", workspace: "workspace" },
    },
  ];
  const frames = [
    { channel: "lifecycle", data: { type: "started" } },
    {
      channel: "snapshot.info",
      data: {
        root: true,
        info: { id: "native", projectID: "p", location: { directory: home }, model: model("A") },
      },
    },
    ...(
      [
        [
          "session.usage.updated",
          { tokens: { input: 100, output: 10, cache: { read: 50, write: 20 } }, cost: 0.0017 },
        ],
        ["session.model.selected", { model: model("B"), previous: model("A") }],
        ["session.step.ended", { tokens: { input: 20, output: 5, cache: { read: 10, write: 0 } } }],
        [
          "session.usage.updated",
          { tokens: { input: 120, output: 15, cache: { read: 60, write: 20 } }, cost: 0.0027 },
        ],
        ["session.step.ended", { tokens: { input: 5, output: 2 } }],
        [
          "session.usage.updated",
          { tokens: { input: 125, output: 17, cache: { read: 60, write: 20 } }, cost: 0.003 },
        ],
      ] satisfies [string, Record<string, unknown>][]
    ).map(([type, data]) => ({
      channel: "sse",
      data: {
        id: String(++identity),
        created: identity,
        type,
        data: { sessionID: "native", ...data },
        location: { directory: home },
      },
    })),
  ];
  try {
    const contextModels: string[] = [],
      occupancy: number[] = [];
    for (const frame of frames)
      for (const fact of translator.translate(
        { seq: ++identity, t: at, dir: "recv", ...frame },
        at,
      )) {
        for (const payload of apply(state, fact, {
          now: at,
          ids: { next: (kind) => `${kind}-${++identity}` },
        })) {
          if (payload.type === "context.sampled") {
            contextModels.push(payload.model ?? "");
            occupancy.push(payload.usedTokens);
          }
          const compact = compactEvent(
            Event.parse({ id: `event-${++seq}`, seq, threadId, at, payload }),
          );
          if (compact) events.push(compact);
        }
      }
    store.ingest({ afterSeq: 0, throughSeq: seq, events });
    expect(state.agents.root?.agent.model).toBe("local/B");
    expect(contextModels).toEqual(["local/B", "local/B"]);
    expect(occupancy).toEqual([35, 7]);
    const rows = store.summary({ from: "2026-10-04", to: "2026-10-04", groupBy: ["model"] }).rows;
    expect(rows).toMatchObject([
      { dimensions: { model: "local/A" }, totals: { inputTokens: 170, outputTokens: 10 } },
      { dimensions: { model: "local/B" }, totals: { inputTokens: 35, outputTokens: 7 } },
    ]);
    expect(rows[0]?.totals.providerReportedUsd).toBeCloseTo(0.0017);
    expect(rows[1]?.totals.providerReportedUsd).toBeCloseTo(0.0013);
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});
