import { expect, it } from "vitest";
import {
  FLOW_WINDOW,
  FlowCredit,
  creditFragment,
  fragmentCost,
  readCredit,
} from "./flow-credit.ts";

const FULL = 65519;

/** Two ends wired back to back: what one returns is what the other is credited. */
function ends() {
  const sender = new FlowCredit();
  const receiver = new FlowCredit();
  const start = sender.start();
  if (!start) throw new Error("Expected a start credit");
  const reply = receiver.credited(readCredit(start));
  if (reply) sender.credited(readCredit(reply));
  return { sender, receiver };
}

it("a sender stops at one window until the reader consumes and credits it back", () => {
  const { sender, receiver } = ends();
  let sent = 0;
  while (sender.allows(fragmentCost(FULL))) {
    sender.spend(fragmentCost(FULL));
    expect(receiver.received(fragmentCost(FULL))).toBe(true);
    sent++;
  }
  expect(sent * FULL).toBeLessThanOrEqual(FLOW_WINDOW);
  for (let index = 0; index < sent; index++) {
    const credit = receiver.consumed(fragmentCost(FULL));
    if (credit) sender.credited(readCredit(credit));
  }
  expect(sender.allows(fragmentCost(FULL))).toBe(true);
});

it("a peer that sends past its window is caught", () => {
  const { receiver } = ends();
  let within = true;
  for (let total = 0; within && total <= FLOW_WINDOW; total += FULL)
    within = receiver.received(fragmentCost(FULL));
  expect(within).toBe(false);
});

it("tiny fragments cost a reader per frame, so one window queues at most 256 of them", () => {
  const { receiver } = ends();
  let queued = 0;
  while (receiver.received(fragmentCost(10))) queued++;
  expect(queued).toBe(256);
});

it("data that arrived before the peer's start is never credited", () => {
  const receiver = new FlowCredit();
  receiver.received(fragmentCost(FULL)); // sent before the peer limited itself
  receiver.credited(0);
  for (let index = 0; index < 5; index++) receiver.received(fragmentCost(FULL));
  // The uncounted fragment and four counted ones stay under the quarter-window step.
  const early = Array.from({ length: 5 }, () => receiver.consumed(fragmentCost(FULL)));
  expect(early.every((credit) => credit === undefined)).toBe(true);
  const credit = receiver.consumed(fragmentCost(FULL));
  expect(credit && readCredit(credit)).toBe(5 * FULL);
});

it("malformed credit fragments are refused", () => {
  expect(readCredit(creditFragment(4096))).toBe(4096);
  for (const bad of [
    new Uint8Array([7, 0, 0, 0]),
    new Uint8Array([6, 0, 0, 0, 1]),
    creditFragment(FLOW_WINDOW + 1),
  ])
    expect(() => readCredit(bad)).toThrow();
});
