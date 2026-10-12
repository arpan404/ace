import { expect, test } from "vitest";
import { pickStrip, stripSlot, type StripFacts } from "./strip-slot.ts";

const facts = (patch: Partial<StripFacts>): StripFacts => ({
  requests: [],
  connection: false,
  queue: false,
  plan: false,
  ...patch,
});

test("approval hides the queue strip but shows a queued indicator", () => {
  const slot = stripSlot(facts({ requests: ["approval-1"], queue: true }), undefined);
  expect(slot).toEqual({ shown: "request", others: ["queue"] });
});

test("the slot goes request, then connection, then queue, then plan", () => {
  const all = facts({ requests: ["a"], connection: true, queue: true, plan: true });
  expect(stripSlot(all, undefined)).toEqual({
    shown: "request",
    others: ["connection", "queue", "plan"],
  });
  expect(stripSlot({ ...all, requests: [] }, undefined).shown).toBe("connection");
  expect(stripSlot({ ...all, requests: [], connection: false }, undefined).shown).toBe("queue");
  expect(stripSlot(facts({ plan: true }), undefined)).toEqual({ shown: "plan", others: [] });
  expect(stripSlot(facts({}), undefined)).toEqual({ shown: undefined, others: [] });
});

test("an indicator switches the slot, and the request becomes an indicator", () => {
  const now = facts({ requests: ["approval-1"], queue: true, plan: true });
  const slot = stripSlot(now, pickStrip("queue", now));
  expect(slot).toEqual({ shown: "queue", others: ["request", "plan"] });
});

test("a new approval reclaims the slot after the user switched to the queue", () => {
  const before = facts({ requests: ["approval-1"], queue: true });
  const pick = pickStrip("queue", before);
  expect(stripSlot(before, pick).shown).toBe("queue");
  const after = { ...before, requests: ["approval-1", "approval-2"] };
  expect(stripSlot(after, pick)).toEqual({ shown: "request", others: ["queue"] });
});

test("answering a request the person already saw leaves the slot where they put it", () => {
  const before = facts({ requests: ["approval-1", "approval-2"], queue: true });
  const pick = pickStrip("queue", before);
  expect(stripSlot({ ...before, requests: ["approval-2"] }, pick).shown).toBe("queue");
});

test("a chosen item that goes away hands the slot back to the most urgent one", () => {
  const before = facts({ connection: true, plan: true });
  const pick = pickStrip("plan", before);
  expect(stripSlot({ ...before, plan: false }, pick)).toEqual({
    shown: "connection",
    others: [],
  });
});

test("choosing the request indicator goes back to the default order", () => {
  const now = facts({ requests: ["a"], queue: true });
  expect(stripSlot(now, pickStrip("request", now)).shown).toBe("request");
});
