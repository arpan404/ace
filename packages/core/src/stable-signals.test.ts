import { expect, test } from "vitest";
import { apply, FactBatch, nextDeadline, type Fact } from "./index.ts";
import { harness } from "./test-helper.ts";

function compare(facts: Fact[], now: number, prepare: (h: ReturnType<typeof harness>) => void) {
  const h = harness("codex", { silenceMs: 100 });
  prepare(h);
  const expected = structuredClone(h.state);
  const actual = structuredClone(h.state);
  let sequence = 0;
  const ctx = { now, ids: { next: (kind: string) => `${kind}-extra-${++sequence}` } };
  const batch = new FactBatch(actual, { deadline: nextDeadline(actual) });
  for (const fact of facts) {
    apply(expected, fact, ctx);
    batch.apply(fact, ctx);
  }
  batch.flush();
  expect(actual).toEqual(expected);
  return actual;
}

test("ordinary signals preserve working status and completed child history", () => {
  const state = compare([{ type: "signal", agent: "root" }], 150, (h) => {
    h.see();
    h.start();
    h.see("child", "root");
    h.start("child");
    h.end("child");
  });
  expect(state.status.state).toBe("working");
});

test("a completed child signal revives its silent ancestor", () => {
  const state = compare([{ type: "signal", agent: "child" }], 300, (h) => {
    h.see();
    h.start();
    h.see("child", "root");
    h.start("child");
    h.end("child");
    h.send({ type: "tick" }, 250);
  });
  expect(state.status.state).toBe("working");
});

test("expired sibling wakes and backward clock signals use full derivation", () => {
  compare([{ type: "signal", agent: "root" }], 300, (h) => {
    h.see();
    h.start();
    h.see("child", "root");
    h.start("child");
    h.end("child");
    h.send({ type: "wake.expected", agent: "child", until: 200 });
  });
  compare([{ type: "signal", agent: "root" }], 50, (h) => {
    h.see();
    h.start();
  });
});

test("a signal earlier than the last tick recomputes unrelated silent descendants", () => {
  compare([{ type: "signal", agent: "idle" }], 150, (h) => {
    h.see();
    h.start();
    h.shell();
    h.see("child", "root");
    h.start("child");
    h.see("idle", "root");
    h.start("idle");
    h.end("idle");
    h.send({ type: "tick" }, 300);
  });
});
