import { expect, test } from "vitest";
import { createTranslator } from "@ace/adapter-claude";
import { apply, createThreadState } from "@ace/core";
import { Event, ThreadId } from "@ace/protocol";
import { UsageStore, compactEvent } from "@ace/usage";

test("Claude root and refined child cache durations price each input token once", () => {
  const usage = new UsageStore(":memory:", {
    priceOverrides: { model: { input: 1, cached: 0.1, write: 2, write1h: 4, output: 10 } },
  });
  const translator = createTranslator({ rootKey: "root" });
  const state = createThreadState({
    threadId: ThreadId.parse("cache"),
    config: { provider: "claude", silenceMs: 60_000 },
  });
  const at = Date.parse("2026-10-02T12:00Z");
  let seq = 0;
  let frame = 0;
  let id = 0;
  const ids = { next: () => `id-${++id}` };
  const deliver = (data: unknown) => {
    for (const fact of translator.translate(
      { seq: frame++, t: 0, dir: "recv", channel: "sdk", data },
      at,
    ))
      for (const payload of apply(state, fact, { now: at, ids })) {
        const event = compactEvent(
          Event.parse({ seq: ++seq, id: `event-${seq}`, at, threadId: "cache", payload }),
        );
        usage.ingest({ afterSeq: seq - 1, throughSeq: seq, events: event ? [event] : [] });
      }
  };
  try {
    usage.ingest({
      afterSeq: 0,
      throughSeq: ++seq,
      events: [
        {
          seq,
          at,
          threadId: "cache",
          payload: { type: "thread.created", workspace: "workspace", provider: "claude" },
        },
      ],
    });
    deliver({ type: "system", subtype: "init", session_id: "native", model: "model" });
    deliver({
      type: "system",
      subtype: "task_started",
      task_id: "child",
      tool_use_id: "spawn",
      task_type: "local_agent",
    });
    const child = Object.values(state.agents).find(
      (record) => record.agent.origin === "provider_subagent",
    )?.agent;
    if (!child) throw new Error("Missing child");
    // Pricing model ownership arrives through the canonical public event path.
    for (const agentId of [state.agents["root"]?.agent.id, child.id]) {
      if (!agentId) throw new Error("Missing agent");
      const event = compactEvent(
        Event.parse({
          seq: ++seq,
          id: `event-${seq}`,
          at,
          threadId: "cache",
          payload: { type: "agent.updated", agentId, model: "model" },
        }),
      );
      usage.ingest({ afterSeq: seq - 1, throughSeq: seq, events: event ? [event] : [] });
    }
    for (const refinement of [false, true, true])
      deliver({
        type: "assistant",
        parent_tool_use_id: "spawn",
        message: {
          id: "child-message",
          content: [{ type: "text", text: "work" }],
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: refinement ? 31 : 30,
            cache_creation: {
              ephemeral_5m_input_tokens: 20,
              ephemeral_1h_input_tokens: refinement ? 11 : 10,
            },
            output_tokens: 2,
          },
        },
      });
    deliver({
      type: "result",
      uuid: "root-result",
      terminal_reason: "completed",
      usage: {
        input_tokens: 2,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 5,
        cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 2 },
        output_tokens: 1,
      },
    });
    const totals = usage.summary({ from: "2026-10-02", to: "2026-10-02", equivalentApiCost: true })
      .rows[0]?.totals;
    expect(totals).toMatchObject({
      inputTokens: 71,
      outputTokens: 3,
      cachedInputTokens: 23,
      cacheWriteTokens: 36,
      cacheWrite1hTokens: 13,
    });
    expect(totals?.equivalentApiUsd).toBeCloseTo(0.0001423, 10);
  } finally {
    usage.close();
  }
});
