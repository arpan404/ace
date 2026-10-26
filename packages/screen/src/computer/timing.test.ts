import { expect, it } from "vitest";
import { ComputerRequestSpan } from "./timing.ts";

it("latency reports preserve native phase timings without logging app content", () => {
  let now = 0;
  const span = new ComputerRequestSpan("act", () => now);
  now = 5;
  span.dequeue();
  now = 15;
  span.ready();
  now = 120;
  span.reply(115, {
    elapsedMs: 95,
    done: ["typed SECRET"],
    timings: { actionMs: 20, finalSettleMs: 60, SECRET: 123 },
    state: {
      nodes: [{ value: "SECRET" }],
      screenshot: { jpeg: "SECRET" },
      timings: { walkMs: 10 },
    },
  });
  now = 125;
  expect(span.finish("ok")).toEqual({
    op: "act",
    outcome: "ok",
    queueMs: 5,
    startupMs: 10,
    helperMs: 100,
    decodeMs: 5,
    totalMs: 125,
    native: {
      elapsedMs: 95,
      phases: { actionMs: 20, finalSettleMs: 60 },
      observation: { walkMs: 10 },
    },
  });
});

it("an older helper's malformed optional metrics cannot break the reply", () => {
  const span = new ComputerRequestSpan("state", () => 1);
  span.dequeue();
  span.ready();
  span.reply(1, { elapsedMs: "old format", timings: { walkMs: "unknown" } });
  expect(span.finish("ok")).toMatchObject({ outcome: "ok", totalMs: 0 });
  expect(span.finish("ok").native).toBeUndefined();
});

it("a partially completed batch reports failure even when its wire envelope succeeded", () => {
  const span = new ComputerRequestSpan("act", () => 1);
  span.dequeue();
  span.ready();
  span.reply(1, {
    done: ["pressed"],
    error: { index: 1, code: "stale_element", message: "SECRET" },
  });
  expect(span.finish("ok").outcome).toBe("error");
  expect(span.finish("cancelled").outcome).toBe("cancelled");
});
