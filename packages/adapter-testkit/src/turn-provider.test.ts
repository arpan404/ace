import { expect, test } from "vitest";
import type { Fact } from "@ace/core";
import { ThreadId } from "@ace/protocol";
import { createTurnProvider, ScriptedTurnConfig } from "./index.ts";

async function fixture() {
  let now = 1000;
  const timers = new Set<{ at: number; callback(): void }>();
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
          timer.callback();
        }
      // Frame delivery is promise-serialized; drain its public close-independent callbacks.
      for (let index = 0; index < 20; index++) await Promise.resolve();
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
