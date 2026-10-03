import { expect, test } from "vitest";
import type { Fact } from "@ace/core";
import { ThreadId } from "@ace/protocol";
import { createTurnProvider, ScriptedTurnConfig } from "./index.ts";

async function fixture() {
  let now = 1000;
  const timers = new Set<{ at: number; callback(): void | Promise<void> }>();
  const facts: Fact[] = [];
  const exits: boolean[] = [];
  const adapter = createTurnProvider({
    provider: "codex",
    reply: "done",
    config: ScriptedTurnConfig.parse({ delayMs: 500, limitAfterTurns: 1, resetMs: 1000 }),
    now: () => now,
    schedule(delay, callback) {
      const timer = { at: now + delay, callback };
      timers.add(timer);
      return () => {
        timers.delete(timer);
      };
    },
  });
  const threadId = ThreadId.parse("slow");
  const translator = adapter.createTranslator({ threadId, rootKey: "root" });
  const session = await adapter.openSession({
    threadId,
    cwd: "/fixture",
    signal: new AbortController().signal,
    onFrame(frame) {
      facts.push(...translator.translate(frame, now));
    },
    onExit(exit) {
      exits.push(exit.deliberate);
    },
  });
  return {
    facts,
    exits,
    session,
    async advance(ms: number) {
      now += ms;
      for (const timer of timers)
        if (timer.at <= now) {
          timers.delete(timer);
          await timer.callback();
        }
    },
  };
}

test("slow scripted turns stay active until their deadline and emit recoverable usage limits", async () => {
  const f = await fixture();
  try {
    await f.session.send([{ type: "text", text: "one" }], "queue");
    expect(f.facts.some((fact) => fact.type === "turn.ended")).toBe(false);
    await f.advance(499);
    expect(f.facts.some((fact) => fact.type === "turn.ended")).toBe(false);
    await f.advance(1);
    expect(f.facts).toContainEqual(
      expect.objectContaining({ type: "turn.ended", outcome: "completed" }),
    );
    await f.session.send([{ type: "text", text: "two" }], "queue");
    await f.advance(500);
    expect(f.facts).toContainEqual(
      expect.objectContaining({ type: "retry", on: "rate_limit", until: 3000 }),
    );
    expect(f.facts).toContainEqual(
      expect.objectContaining({
        type: "turn.ended",
        outcome: "failed",
        error: { kind: "quota", message: "Scripted usage limit" },
      }),
    );
    await f.advance(999);
    expect(f.facts.some((fact) => fact.type === "limit.cleared")).toBe(false);
    await f.advance(1);
    expect(f.facts).toContainEqual({ type: "limit.cleared", agent: "root" });
    await f.session.send([{ type: "text", text: "three" }], "queue");
    await f.advance(500);
    expect(
      f.facts.filter((fact) => fact.type === "turn.ended" && fact.outcome === "completed"),
    ).toHaveLength(2);
  } finally {
    await f.session.close("shutdown");
  }
});

test("interrupting or closing a slow scripted turn cancels its delayed completion", async () => {
  const f = await fixture();
  await f.session.send([{ type: "text", text: "interrupt" }], "queue");
  await f.session.interrupt({ cascade: false });
  await f.advance(500);
  expect(f.facts.filter((fact) => fact.type === "turn.ended")).toEqual([
    expect.objectContaining({ outcome: "interrupted" }),
  ]);
  await f.session.send([{ type: "text", text: "close" }], "queue");
  await f.session.close("shutdown");
  const before = f.facts.length;
  await f.advance(2000);
  expect(f.facts).toHaveLength(before);
  expect(f.exits).toEqual([true]);
});

test("closing during initial delivery frees timer capacity for another session and emits no later facts or exits", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let now = 1000;
  // Model a bounded timer resource. A leaked closed turn prevents a new public send.
  const timers = new Set<{ at: number; callback(): void | Promise<void> }>();
  const adapter = createTurnProvider({
    provider: "codex",
    reply: "done",
    config: ScriptedTurnConfig.parse({ delayMs: 500 }),
    now: () => now,
    schedule(delay, callback) {
      if (timers.size) throw new Error("Timer capacity exhausted");
      const timer = { at: now + delay, callback };
      timers.add(timer);
      return () => {
        timers.delete(timer);
      };
    },
  });
  const firstFacts: Fact[] = [],
    secondFacts: Fact[] = [],
    exits: boolean[] = [];
  const firstId = ThreadId.parse("closing");
  const firstTranslator = adapter.createTranslator({ threadId: firstId, rootKey: "root" });
  const first = await adapter.openSession({
    threadId: firstId,
    cwd: "/fixture",
    signal: new AbortController().signal,
    async onFrame(frame) {
      firstFacts.push(...firstTranslator.translate(frame, now));
      entered.resolve();
      await release.promise;
    },
    onExit(exit) {
      exits.push(exit.deliberate);
    },
  });
  const send = first.send([{ type: "text", text: "close" }], "queue");
  await entered.promise;
  const close = first.close("shutdown");
  release.resolve();
  await Promise.all([close, send]);
  const before = firstFacts.slice();
  const secondId = ThreadId.parse("replacement");
  const secondTranslator = adapter.createTranslator({ threadId: secondId, rootKey: "root" });
  const second = await adapter.openSession({
    threadId: secondId,
    cwd: "/fixture",
    signal: new AbortController().signal,
    onFrame(frame) {
      secondFacts.push(...secondTranslator.translate(frame, now));
    },
    onExit() {},
  });
  try {
    await second.send([{ type: "text", text: "replacement" }], "queue");
    expect(secondFacts.some((fact) => fact.type === "turn.ended")).toBe(false);
    now += 500;
    for (const timer of timers)
      if (timer.at <= now) {
        timers.delete(timer);
        await timer.callback();
      }
    expect(secondFacts).toContainEqual(
      expect.objectContaining({ type: "turn.ended", outcome: "completed" }),
    );
    expect(firstFacts).toEqual(before);
    expect(exits).toEqual([true]);
  } finally {
    await second.close("shutdown");
  }
});

test("the e2e hold and limit markers still expose working turns to queue and stop controls", async () => {
  const facts: Fact[] = [];
  const adapter = createTurnProvider({
    provider: "codex",
    reply: "done",
    config: ScriptedTurnConfig.parse({}),
    markers: { hold: "hold-marker", limit: "limit-marker", notice: "Limit reached" },
    now: () => 1,
    schedule: () => () => {},
  });
  const threadId = ThreadId.parse("markers"),
    translator = adapter.createTranslator({ threadId, rootKey: "root" });
  const session = await adapter.openSession({
    threadId,
    cwd: "/fixture",
    signal: new AbortController().signal,
    onFrame: (frame) => {
      facts.push(...translator.translate(frame, 1));
    },
    onExit() {},
  });
  try {
    await session.send([{ type: "text", text: "hold-marker" }], "queue");
    expect(facts.filter((fact) => fact.type === "turn.ended")).toEqual([]);
    await session.send([{ type: "text", text: "steer" }], "steer");
    expect(facts).toContainEqual(
      expect.objectContaining({ type: "turn.ended", outcome: "completed" }),
    );
    await session.send([{ type: "text", text: "limit-marker" }], "queue");
    expect(facts).toContainEqual(
      expect.objectContaining({ type: "retry", on: "rate_limit", message: "Limit reached" }),
    );
    await session.interrupt({ cascade: false });
    expect(facts).toContainEqual(
      expect.objectContaining({ type: "turn.ended", outcome: "interrupted" }),
    );
  } finally {
    await session.close("shutdown");
  }
});
