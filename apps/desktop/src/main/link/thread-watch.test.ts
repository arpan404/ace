import { ThreadListEntry, type ThreadStatus } from "@ace/protocol";
import { expect, it } from "vitest";
import { derivedAlerts, WorkTally } from "./thread-watch.ts";

const entry = (
  id: string,
  status: ThreadStatus,
  archivedAt?: number,
  extra: Record<string, unknown> = {},
) =>
  ThreadListEntry.parse({
    ...extra,
    id,
    workspaceId: "ace",
    title: `Thread ${id}`,
    provider: "codex",
    createdAt: 0,
    updatedAt: 1,
    status,
    ...(archivedAt === undefined ? {} : { archivedAt }),
  });

it("counts threads that need the person and threads with work in flight", () => {
  const tally = new WorkTally();
  tally.set("a", entry("a", { state: "needs_you", interactions: 1 }));
  tally.set("b", entry("b", { state: "working", agents: 2 }));
  tally.set("c", entry("c", { state: "waiting", on: "rate_limit" }));
  tally.set("d", entry("d", { state: "done" }));
  expect(tally.summary()).toEqual({
    needsYou: 1,
    working: 2,
    held: 0,
    hostedWorking: 0,
    hostedWaiting: 0,
  });
});

it("moves a thread between counts as its status changes, and drops it when it goes", () => {
  const tally = new WorkTally();
  tally.set("a", entry("a", { state: "working", agents: 1 }));
  expect(tally.set("a", entry("a", { state: "needs_you", interactions: 1 }))).toBe(true);
  expect(tally.summary()).toEqual({
    needsYou: 1,
    working: 0,
    held: 0,
    hostedWorking: 0,
    hostedWaiting: 0,
  });
  expect(tally.set("a", undefined)).toBe(true);
  expect(tally.summary()).toEqual({
    needsYou: 0,
    working: 0,
    held: 0,
    hostedWorking: 0,
    hostedWaiting: 0,
  });
});

it("reports no change while a busy thread streams without changing what it counts as", () => {
  const tally = new WorkTally();
  tally.set("a", entry("a", { state: "working", agents: 1 }));
  const before = tally.summary();
  expect(tally.set("a", entry("a", { state: "working", agents: 3 }))).toBe(false);
  expect(tally.set("a", entry("a", { state: "waiting", on: "network" }))).toBe(false);
  expect(tally.summary()).toBe(before);
});

it("never counts an archived thread, whatever its status", () => {
  const tally = new WorkTally();
  tally.set("a", entry("a", { state: "needs_you", interactions: 1 }));
  expect(tally.set("a", entry("a", { state: "needs_you", interactions: 1 }, 5))).toBe(true);
  expect(tally.summary()).toEqual({
    needsYou: 0,
    working: 0,
    held: 0,
    hostedWorking: 0,
    hostedWaiting: 0,
  });
});

it("counts a thread paused at a usage limit or with a silent agent as held, not done", () => {
  const tally = new WorkTally();
  tally.set("a", entry("a", { state: "limited", until: 10 }));
  tally.set("b", entry("b", { state: "unresponsive" }));
  tally.set("c", entry("c", { state: "failed" }));
  expect(tally.summary()).toEqual({
    needsYou: 0,
    working: 0,
    held: 2,
    hostedWorking: 0,
    hostedWaiting: 0,
  });
  tally.set("a", entry("a", { state: "working", agents: 1 }));
  expect(tally.summary()).toEqual({
    needsYou: 0,
    working: 1,
    held: 1,
    hostedWorking: 0,
    hostedWaiting: 0,
  });
});

const fromPairedMachine = { delegatedFrom: { hostId: "host-a", threadId: "parent-on-a" } };

it("a paired machine's child adds nothing to the needs-you, working or held counts, only to work hosted here", () => {
  const tally = new WorkTally();
  tally.set("mine", entry("mine", { state: "needs_you", interactions: 1 }));
  tally.set(
    "asks",
    entry("asks", { state: "needs_you", interactions: 1 }, undefined, fromPairedMachine),
  );
  tally.set("runs", entry("runs", { state: "working", agents: 1 }, undefined, fromPairedMachine));
  tally.set(
    "paused",
    entry("paused", { state: "limited", until: 10 }, undefined, fromPairedMachine),
  );
  expect(tally.summary()).toEqual({
    needsYou: 1,
    working: 0,
    held: 0,
    hostedWorking: 1,
    hostedWaiting: 2,
  });
});

it("a local thread pausing at a usage limit alerts; a paired machine's child doing so does not", () => {
  const working = { state: "working", agents: 1 } as const;
  const limited = { state: "waiting", on: "rate_limit" } as const;
  expect(derivedAlerts(entry("a", working), entry("a", limited))).toEqual([
    expect.objectContaining({ category: "limited", threadId: "a" }),
  ]);
  expect(
    derivedAlerts(
      entry("b", working, undefined, fromPairedMachine),
      entry("b", limited, undefined, fromPairedMachine),
    ),
  ).toEqual([]);
});
