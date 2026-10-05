import { expect, test } from "vitest";
import { entry } from "./test-entries.fixture.ts";
import { cardDetails, middleTruncate, threadCard, type ThreadCardInput } from "./thread-card.ts";

const now = new Date("2026-10-01T15:00:00").getTime();
const input = (patch: Partial<ThreadCardInput> & Pick<ThreadCardInput, "entry">) => ({
  baseline: 0,
  settled: false,
  now,
  locale: "en-US",
  ...patch,
});

test("a card shows the daemon's title, the project and how long ago it last worked", () => {
  const card = threadCard(
    input({
      entry: entry("t", { state: "done" }, now, {
        workspaceId: "web",
        title: "Renamed on the phone",
        activityAt: now - 3 * 60_000,
      }),
    }),
  );
  expect(card).toMatchObject({ title: "Renamed on the phone", project: "web", age: "3m" });
});

test("a card names its project when the daemon's name is known", () => {
  const card = threadCard(
    input({
      entry: entry("t", { state: "done" }, now, { workspaceId: "6f1c2a9e-0d4b" }),
      projectName: "relay",
    }),
  );
  expect(card.project).toBe("relay");
});

test("finished work the person hasn't opened is emphasised and announced as unread", () => {
  const card = threadCard(input({ entry: entry("t", { state: "done" }, now - 1000) }));
  expect(card.emphasis).toBe(true);
  expect(card.announceUnread).toBe(true);
  const read = threadCard(
    input({ entry: entry("t", { state: "done" }, now - 1000, { readAt: now, unread: false }) }),
  );
  expect(read.emphasis).toBe(false);
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
  const card = threadCard(
    input({ entry: entry("t", { state: "done" }, now, { snoozedUntil: until }) }),
  );
  expect(card.flags.snoozed).toBe(true);
  expect(card.wake).toBe("tomorrow 9:00 AM");
  const woke = threadCard(
    input({ entry: entry("t", { state: "done" }, now, { snoozedUntil: now - 1 }) }),
  );
  expect(woke.wake).toBeUndefined();
});

test("branch, pull request, worktree and machine come from the daemon's details", () => {
  const remote = entry("t", { state: "done" }, now, {
    details: {
      branch: "fix/retry",
      mode: "worktree",
      linkedPr: { number: 188, state: "open" },
      machine: { host: "build-box.local", name: "build-box" },
      diff: { files: 3, additions: 64, deletions: 12 },
    },
  });
  const card = threadCard(input({ entry: remote, details: cardDetails(remote, "laptop.local") }));
  expect(card.branch).toEqual({ name: "fix/retry", label: "fix/retry", pr: 188, worktree: true });
  expect(card.machine).toBe("build-box");
  expect(cardDetails(remote, "build-box.local").machine).toBeUndefined();
});

test("a thread with no branch yet shows none rather than an empty one", () => {
  const detached = entry("t", { state: "done" }, now, { details: { branch: null } });
  expect(
    threadCard(input({ entry: detached, details: cardDetails(detached, undefined) })).branch,
  ).toBeUndefined();
});

test("a thread on the project's default branch names no branch", () => {
  for (const branch of ["main", "master"]) {
    const local = entry("t", { state: "done" }, now, { details: { branch } });
    expect(
      threadCard(input({ entry: local, details: cardDetails(local, undefined) })).branch,
    ).toBeUndefined();
  }
});

test("a long branch is cut in the middle for the row and kept whole for the tooltip", () => {
  const long = entry("t", { state: "done" }, now, {
    details: { branch: "ace/33594883e2b3ea4fc70aeea5", mode: "worktree" },
  });
  const branch = threadCard(input({ entry: long, details: cardDetails(long, undefined) })).branch;
  expect(branch?.name).toBe("ace/33594883e2b3ea4fc70aeea5");
  expect(branch?.label).toBe("ace/335…0aeea5");
});

test("middle truncation keeps short text and both ends of long text", () => {
  expect(middleTruncate("fix/retry", 16)).toBe("fix/retry");
  expect(middleTruncate("deck/resumable-streams", 16)).toBe("deck/res…streams");
  expect(middleTruncate("abcdef", 2)).toBe("ab");
  // Characters, not UTF-16 units: an emoji in a branch name is never split in half.
  expect(middleTruncate("🚀".repeat(12), 5)).toBe("🚀🚀…🚀🚀");
});
