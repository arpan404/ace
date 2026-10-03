import { expect, test } from "vitest";
import { entry } from "./test-entries.fixture.ts";
import { threadCard, type ThreadCardInput } from "./thread-card.ts";

const now = new Date("2026-10-01T15:00:00").getTime();
const input = (patch: Partial<ThreadCardInput> & Pick<ThreadCardInput, "entry">) => ({
  mark: undefined,
  baseline: 0,
  settled: false,
  now,
  locale: "en-US",
  ...patch,
});

test("a card shows the local rename, the project and a compact age", () => {
  const card = threadCard(
    input({
      entry: entry("t", { state: "done" }, now - 3 * 60_000, { workspaceId: "web" }),
      mark: { title: "Renamed here", seenAt: now },
    }),
  );
  expect(card).toMatchObject({ title: "Renamed here", project: "web", age: "3m" });
});

test("finished work the person hasn't opened is emphasised and announced as unread", () => {
  const card = threadCard(input({ entry: entry("t", { state: "done" }, now - 1000) }));
  expect(card.emphasis).toBe(true);
  expect(card.announceUnread).toBe(true);
  const seen = threadCard(
    input({ entry: entry("t", { state: "done" }, now - 1000), mark: { seenAt: now } }),
  );
  expect(seen.emphasis).toBe(false);
});

test("a thread that needs you is emphasised without a second unread announcement", () => {
  const card = threadCard(
    input({ entry: entry("t", { state: "needs_you", interactions: 2 }, now) }),
  );
  expect(card.emphasis).toBe(true);
  expect(card.announceUnread).toBe(false);
  expect(card.status).toEqual({ label: "Needs you", tone: "needs-you", mark: "needs-you" });
});

test("a working thread counts the subagents beside its main agent", () => {
  const card = threadCard(input({ entry: entry("t", { state: "working", agents: 3 }, now) }));
  expect(card.subagents).toBe(2);
  expect(card.providerLabel).toBe("Codex · 2 subagents running");
  expect(card.status.mark).toBe("working");
});

test("a snoozed card says when it wakes; an expired snooze says nothing", () => {
  const until = new Date("2026-10-02T09:00:00").getTime();
  const done = entry("t", { state: "done" }, now);
  const card = threadCard(input({ entry: done, mark: { snoozedUntil: until } }));
  expect(card.flags.snoozed).toBe(true);
  expect(card.wake).toBe("tomorrow 9:00 AM");
  const woke = threadCard(input({ entry: done, mark: { snoozedUntil: now - 1 } }));
  expect(woke.wake).toBeUndefined();
});

test("branch, pull request, worktree and machine come from the thread's details", () => {
  const card = threadCard(
    input({
      entry: entry("t", { state: "done" }, now),
      details: { branch: "fix/retry", pr: 188, worktree: true, machine: "build-box" },
    }),
  );
  expect(card.branch).toEqual({ name: "fix/retry", pr: 188, worktree: true });
  expect(card.machine).toBe("build-box");
});
