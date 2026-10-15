import { expect, test } from "vitest";
import { queuedInputLine } from "./queued-input.ts";

const flowing = { paused: false, reason: null };
const notSent = { paused: true, reason: "not_sent" } as const;
const queueWait = { state: "waiting", on: "queue" } as const;

test("a message the provider could not accept is the failed item only, never also queued", () => {
  // The daemon retains it at the head of a held queue and the thread waits on that queue.
  expect(
    queuedInputLine({ retained: 1, queue: notSent, status: queueWait, agentFailed: true }),
  ).toBeUndefined();
});

test("messages behind one that wasn't sent wait for it rather than for the agent", () => {
  expect(
    queuedInputLine({ retained: 3, queue: notSent, status: queueWait, agentFailed: true }),
  ).toEqual({
    count: 2,
    label: "2 queued messages",
    when: "wait for the message that wasn't sent",
  });
});

test("queued input never claims it sends when the agent is free while the agent has failed", () => {
  const line = queuedInputLine({
    retained: 1,
    queue: flowing,
    status: queueWait,
    agentFailed: true,
  });
  expect(line?.label).toBe("1 queued message");
  expect(line?.when).not.toMatch(/when the agent is free/);
  expect(
    queuedInputLine({
      retained: 1,
      queue: flowing,
      status: { state: "failed" },
      agentFailed: false,
    })?.when,
  ).not.toMatch(/when the agent is free/);
});

test("a held queue says it is held, not that it sends by itself", () => {
  expect(
    queuedInputLine({
      retained: 2,
      queue: { paused: true, reason: "restart" },
      status: queueWait,
      agentFailed: false,
    })?.when,
  ).toBe("held until you continue");
});

test("queued input behind a working agent sends when the agent is free", () => {
  expect(
    queuedInputLine({
      retained: 1,
      queue: flowing,
      status: { state: "working", agents: 1 },
      agentFailed: false,
    }),
  ).toEqual({ count: 1, label: "1 queued message", when: "sends when the agent is free" });
  expect(
    queuedInputLine({ retained: 0, queue: undefined, status: queueWait, agentFailed: false }),
  ).toEqual({ count: 0, label: "Queued messages", when: "send when the agent is free" });
  expect(
    queuedInputLine({
      retained: 0,
      queue: flowing,
      status: { state: "done" },
      agentFailed: false,
    }),
  ).toBeUndefined();
});
