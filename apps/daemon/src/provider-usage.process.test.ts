import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, createThreadState } from "@ace/core";
import { createTranslator } from "@ace/adapter-claude";
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
