import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createTranslator as claudeTranslator } from "@ace/adapter-claude";
import { createCodexAdapter } from "@ace/adapter-codex";
import { createCursorAdapter } from "@ace/adapter-cursor";
import { createOpenCodeAdapter } from "@ace/adapter-opencode";
import { readFixture } from "@ace/adapter-testkit";
import { apply, createThreadState, type CoreConfig, type Fact } from "@ace/core";
import type { ProviderAdapter } from "@ace/engine-api";
import { Event, type EventPayload, type ThreadId } from "@ace/protocol";
import { expect, test } from "vitest";
import { canonicalEvent, plannedPayloadTypes } from "./canonical-event.ts";

/*
 * The writer stores what `canonicalEvent` returns. It must be what `Event.parse` returns for every
 * input: the same JSON (values, defaults, key order), the same keys present as undefined, and a
 * rejection wherever Event.parse rejects.
 */

type Outcome = { ok: true; json: string; value: unknown } | { ok: false };
function outcome(run: () => unknown): Outcome {
  try {
    const value = run();
    return { ok: true, json: JSON.stringify(value), value };
  } catch {
    return { ok: false };
  }
}
function expectSame(input: unknown): void {
  const expected = outcome(() => Event.parse(input));
  const actual = outcome(() => canonicalEvent(input));
  expect(actual.ok, JSON.stringify(input)).toBe(expected.ok);
  if (!actual.ok || !expected.ok) return;
  expect(actual.json).toBe(expected.json);
  expect(actual.value).toStrictEqual(expected.value);
}

const envelope: Record<string, unknown> = {
  seq: 7,
  id: "event-7",
  at: 1_700_000_000_000,
  threadId: "thread-1",
};
/** A valid payload of each variant with a plan, every optional field given. */
const samples: Record<string, Record<string, unknown>> = {
  "input.admitted": {
    type: "input.admitted",
    agentId: "agent-1",
    nativeInputId: "native-1",
    commandId: "command-1",
  },
  "item.delta": {
    type: "item.delta",
    itemId: "item-1",
    agentId: "agent-1",
    field: "text",
    append: '{"index":3,"sentAt":1700000000000}\n',
  },
  "item.deleted": { type: "item.deleted", itemId: "item-1" },
  "background_task.updated": {
    type: "background_task.updated",
    taskId: "task-1",
    status: "completed",
    endedAt: 1_700_000_000_500,
  },
  "context.sampled": {
    type: "context.sampled",
    agentId: "agent-1",
    usedTokens: 1200,
    windowTokens: 200_000,
    sessionId: "session-1",
    model: "model-1",
  },
};
const odd: unknown[] = [
  undefined,
  null,
  "",
  "x",
  "x".repeat(600),
  "text",
  "output",
  "reasoning",
  "completed",
  0,
  -1,
  1.5,
  2 ** 53,
  Number.NaN,
  Infinity,
  true,
  [],
  {},
];

test("every payload variant with a plan has a sample here", () => {
  expect([...plannedPayloadTypes()].toSorted()).toEqual(Object.keys(samples).toSorted());
  expect(plannedPayloadTypes().has("item.delta")).toBe(true);
});

test("planned variants canonicalise as Event.parse does, whatever their fields hold", () => {
  for (const sample of Object.values(samples)) {
    expectSame({ ...envelope, payload: sample });
    // Keys in another order, unknown keys, and optional keys present as undefined.
    expectSame({ payload: Object.fromEntries(Object.entries(sample).toReversed()), ...envelope });
    expectSame({ ...envelope, extra: 1, payload: { ...sample, extra: "dropped" } });
    for (const key of Object.keys(sample)) {
      const { [key]: _, ...without } = sample;
      expectSame({ ...envelope, payload: without });
      for (const value of odd) expectSame({ ...envelope, payload: { ...sample, [key]: value } });
    }
  }
});

test("envelopes canonicalise as Event.parse does, valid or not", () => {
  const payload = samples["item.delta"];
  for (const key of Object.keys(envelope)) {
    const { [key]: _, ...without } = envelope;
    expectSame({ ...without, payload });
    for (const value of odd) expectSame({ ...envelope, [key]: value, payload });
  }
  for (const value of odd) expectSame({ ...envelope, payload: value });
  for (const value of odd) expectSame(value);
  expectSame({ ...envelope, payload: { ...payload, type: "item.unheard_of" } });
  expectSame({ ...envelope, payload: { type: "unknown", raw: { kept: [1, 2] } } });
});

test("the scripted bench's deltas canonicalise as Event.parse does", () => {
  for (let index = 0; index < 200; index++)
    expectSame({
      ...envelope,
      seq: index,
      payload: {
        type: "item.delta",
        agentId: "agent-root",
        itemId: "item-stream",
        field: index % 3 === 0 ? "reasoning" : "text",
        append: JSON.stringify({ index, sentAt: 1_700_000_000_000 + index }) + "\n",
      },
    });
});

const fixtures = join(import.meta.dirname, "../../../fixtures");
const recordings: {
  dir: string;
  createTranslator: ProviderAdapter["createTranslator"];
  config: CoreConfig;
}[] = [
  {
    dir: "claude/2.1.286",
    createTranslator: claudeTranslator,
    config: { provider: "claude", silenceMs: 60_000 },
  },
  {
    dir: "codex/0.159.1",
    createTranslator: createCodexAdapter().createTranslator,
    config: { provider: "codex", silenceMs: 90_000 },
  },
  {
    dir: "opencode/2.0.22/muse-spark-1.3-contributor",
    createTranslator: createOpenCodeAdapter().createTranslator,
    config: { provider: "opencode", liveness: "transport", silenceMs: 25_000 },
  },
  {
    dir: "cursor-sdk/1.0.35/composer-2.5",
    createTranslator: createCursorAdapter().createTranslator,
    config: { provider: "cursor", silenceMs: 90_000 },
  },
];

/** The payloads a recording produces through its adapter and the core, in order. */
async function payloadsOf(
  file: string,
  createTranslator: ProviderAdapter["createTranslator"],
  config: CoreConfig,
): Promise<EventPayload[]> {
  const fixture = await readFixture(file);
  const threads = fixture.threads ? Object.entries(fixture.threads) : [["root", fixture.frames]];
  const payloads: EventPayload[] = [];
  for (const [threadKey, frames] of threads) {
    // Trusted: a test-made id.
    const threadId = `thread-${String(threadKey)}` as ThreadId;
    const state = createThreadState({ threadId, config });
    const translator = createTranslator({ threadId, rootKey: "root" });
    let id = 0;
    const ids = { next: (kind: string) => `${kind}-${++id}` };
    const fold = (facts: Fact[], now: number) => {
      for (const fact of facts) payloads.push(...apply(state, fact, { now, ids }));
    };
    for (const frame of frames as typeof fixture.frames) {
      fold(translator.translate(structuredClone(frame), frame.t), frame.t);
      fold(translator.tick(frame.t), frame.t);
      fold([{ type: "tick" }], frame.t);
    }
  }
  return payloads;
}

test("recorded provider sessions canonicalise exactly as Event.parse does", async () => {
  const seen = new Set<string>();
  let count = 0;
  for (const { dir, createTranslator, config } of recordings)
    for (const name of readdirSync(join(fixtures, dir))) {
      const file = join(fixtures, dir, name);
      if (!name.endsWith(".jsonl") || !statSync(file).isFile()) continue;
      for (const payload of await payloadsOf(file, createTranslator, config)) {
        expectSame({ ...envelope, seq: ++count, payload });
        seen.add(payload.type);
      }
    }
  // The recordings stream text and settle work, so the planned paths ran on real payloads.
  expect(seen.has("item.delta")).toBe(true);
  expect(count).toBeGreaterThan(1000);
});
