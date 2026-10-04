import { ThreadListEntry, type ThreadStatus } from "@ace/protocol";
import { expect, it } from "vitest";
import { WorkTally } from "./thread-watch.ts";

const entry = (id: string, status: ThreadStatus, archivedAt?: number) =>
  ThreadListEntry.parse({
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
  expect(tally.summary()).toEqual({ needsYou: 1, working: 2 });
});

it("moves a thread between counts as its status changes, and drops it when it goes", () => {
  const tally = new WorkTally();
  tally.set("a", entry("a", { state: "working", agents: 1 }));
  expect(tally.set("a", entry("a", { state: "needs_you", interactions: 1 }))).toBe(true);
  expect(tally.summary()).toEqual({ needsYou: 1, working: 0 });
  expect(tally.set("a", undefined)).toBe(true);
  expect(tally.summary()).toEqual({ needsYou: 0, working: 0 });
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
  expect(tally.summary()).toEqual({ needsYou: 0, working: 0 });
});
