import { expect, test } from "vitest";
import { entry } from "./test-entries.fixture.ts";
import { currentAttention } from "./row-attention.ts";
import {
  cardDetails,
  middleTruncateText,
  threadCard,
  threadRowStatus,
  type ThreadCardInput,
} from "./thread-card.ts";

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

test("finished work the person hasn't opened says Done and is announced as unread", () => {
  const card = threadCard(input({ entry: entry("t", { state: "done" }, now - 1000) }));
  expect(card.attention).toMatchObject({ level: "done-unread", word: "Done", muted: false });
  expect(card.announceUnread).toBe(true);
  const read = threadCard(
    input({ entry: entry("t", { state: "done" }, now - 1000, { readAt: now, unread: false }) }),
  );
  expect(read.attention).toMatchObject({ level: "quiet", word: undefined, muted: true });
});

test("a thread that needs you is strongest without a second unread announcement", () => {
  const card = threadCard(
    input({ entry: entry("t", { state: "needs_you", interactions: 2 }, now) }),
  );
  expect(card.attention).toMatchObject({ level: "needs-you", tone: "needs-you", muted: false });
  expect(card.announceUnread).toBe(false);
  expect(card.status).toMatchObject({
    label: "Needs you",
    compact: "Needs you",
    tone: "needs-you",
    mark: "needs-you",
  });
});

test("a thread held at its account's usage limit is marked in the list, unlike a waiting one", () => {
  const limited = threadCard(input({ entry: entry("t", { state: "limited" }, now) }));
  expect(limited.status).toMatchObject({
    label: "Limited",
    compact: "Limited",
    tone: "waiting",
    mark: "limited",
  });
  const waiting = threadCard(
    input({ entry: entry("t", { state: "waiting", on: "background_task" }, now) }),
  );
  expect(waiting.status.mark).toBe("none");
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

test("a thread on the default branch still shows where it runs", () => {
  for (const branch of ["main", "master"]) {
    const local = entry("t", { state: "done" }, now, { details: { branch } });
    expect(
      threadCard(input({ entry: local, details: cardDetails(local, undefined) })).branch,
    ).toMatchObject({ name: branch });
  }
});

test("a long branch is cut in the middle for the row and kept whole for the tooltip", () => {
  const long = entry("t", { state: "done" }, now, {
    details: { branch: "ace/33594883e2b3ea4fc70aeea5", mode: "worktree" },
  });
  const branch = threadCard(input({ entry: long, details: cardDetails(long, undefined) })).branch;
  expect(branch?.name).toBe("ace/33594883e2b3ea4fc70aeea5");
  expect(branch?.label).toBe("ace/33594883…a4fc70aeea5");
});

test("middle truncation keeps short text and both ends of long text", () => {
  expect(middleTruncateText("fix/retry", 16)).toBe("fix/retry");
  expect(middleTruncateText("work/resumable-streams", 16)).toBe("work/res…streams");
  expect(middleTruncateText("abcdef", 2)).toBe("ab");
  // Characters, not UTF-16 units: an emoji in a branch name is never split in half.
  expect(middleTruncateText("🚀".repeat(12), 5)).toBe("🚀🚀…🚀🚀");
});

test("a working thread's pill counts from when it started working", () => {
  const card = threadCard(
    input({
      entry: entry("t", { state: "working", agents: 1 }, now, { activityAt: now - 18_000 }),
    }),
  );
  expect(card.pill).toEqual({
    label: "Working",
    tone: "working",
    icon: "working",
    since: now - 18_000,
  });
});

test("finished work shows Done until it is read, then its age, quietly", () => {
  const unread = threadCard(input({ entry: entry("t", { state: "done" }, now - 1000) }));
  expect(unread.pill?.label).toBe("Done");
  expect(unread.attention.muted).toBe(false);
  const read = threadCard(
    input({ entry: entry("t", { state: "done" }, now - 1000, { readAt: now, unread: false }) }),
  );
  expect(read.pill).toBeUndefined();
  expect(read.attention.muted).toBe(true);
});

test("once read, a request stays strong, a failure goes quiet and waiting keeps its word", () => {
  const read = { readAt: now, unread: false };
  for (const [status, label, level] of [
    [{ state: "needs_you", interactions: 1 }, "Needs you", "needs-you"],
    [{ state: "failed" }, "Failed", "failed-seen"],
    [{ state: "limited" }, "Limited", "active"],
    [{ state: "waiting", on: "rate_limit" }, "Waiting", "active"],
  ] as const) {
    const card = threadCard(input({ entry: entry("t", status, now - 1000, read) }));
    expect(card.pill?.label).toBe(label);
    expect(card.attention.level).toBe(level);
  }
});

test("a failure is strong until it is seen", () => {
  const unseen = threadCard(input({ entry: entry("t", { state: "failed" }, now - 1000) }));
  expect(unseen.attention).toMatchObject({ level: "failed", word: "Failed", tone: "failed" });
  const seen = threadCard(
    input({ entry: entry("t", { state: "failed" }, now - 1000, { readAt: now, unread: false }) }),
  );
  expect(seen.attention).toMatchObject({ level: "failed-seen", word: "Failed", muted: true });
});

test("working is calm in a row that isn't open, and full contrast in the open one", () => {
  const card = threadCard(input({ entry: entry("t", { state: "working", agents: 1 }, now) }));
  expect(card.attention).toMatchObject({ level: "active", word: "Working", muted: true });
  expect(currentAttention(card.attention, true)).toMatchObject({ word: "Working", muted: false });
  // Opening never quiets what needs the person.
  const asking = threadCard(
    input({ entry: entry("t", { state: "needs_you", interactions: 1 }, now) }),
  );
  expect(currentAttention(asking.attention, false).muted).toBe(false);
});

test("new activity after reading makes a finished thread unread again", () => {
  const read = { readAt: now - 5000 };
  const again = threadCard(input({ entry: entry("t", { state: "done" }, now - 1000, read) }));
  expect(again.attention).toMatchObject({ level: "done-unread", word: "Done" });
});

test("a settled row is quiet and shows no pill", () => {
  const card = threadCard(
    input({ entry: entry("t", { state: "done" }, now - 1000), settled: true }),
  );
  expect(card.pill).toBeUndefined();
  expect(card.attention).toMatchObject({ level: "quiet", word: undefined });
});

test("diff stats show only when the checkout changed", () => {
  const changed = threadCard(
    input({
      entry: entry("t", { state: "done" }, now),
      details: { diff: { added: 126, removed: 4 } },
    }),
  );
  expect(changed.diff).toEqual({ added: 126, removed: 4 });
  const clean = threadCard(
    input({
      entry: entry("t", { state: "done" }, now),
      details: { diff: { added: 0, removed: 0 } },
    }),
  );
  expect(clean.diff).toBeUndefined();
});

test("a row says what its thread is doing when the daemon's live hints know more than its state", () => {
  const card = (status: Parameters<typeof entry>[1], live: Record<string, unknown>) =>
    threadCard(
      input({ entry: entry("t", status, now, { live: { provider: "claude", ...live } }) }),
    );

  const watching = card(
    { state: "waiting", on: "background_task" },
    { watching: [{ id: "relay", title: "bun run dev:relay" }] },
  );
  // The turn is over and only the command runs: neither Working nor Done, a quiet Background.
  expect(watching.pill).toMatchObject({
    label: "Running in background",
    code: "bun run dev:relay",
    tone: "background",
    icon: "background",
  });
  expect(watching.pill?.since).toBeUndefined();
  expect(watching.status).toMatchObject({
    label: "Running in background bun run dev:relay",
    compact: "Background · 1",
    tone: "background",
  });

  const subagents = card({ state: "working", agents: 3 }, { waitingOn: 2 });
  expect(subagents.pill).toMatchObject({ label: "Working", tone: "working" });
  expect(subagents.status).toMatchObject({ label: "Working", compact: "Working" });
  expect(subagents.status.label).not.toMatch(/Waiting/);
  expect(subagents.status.since).toBe(subagents.pill?.since);

  const asking = card(
    { state: "needs_you", interactions: 1 },
    {
      asking: [{ id: "ask", kind: "question" }],
    },
  );
  expect(asking.pill).toMatchObject({ label: "Waiting for your answer", tone: "needs-you" });
  expect(asking.status.compact).toBe("Answer");

  const testing = card({ state: "working", agents: 1 }, { step: "tests" });
  expect(testing.status.label).toBe("Working · running tests");
  expect(testing.status.compact).toBe("Working");

  const limited = card({ state: "limited", until: now + 20 * 60_000 }, {});
  expect(limited.pill?.label).toBe("Limited until 3:20 PM");
  expect(limited.status.compact).toBe("Limited 15:20");

  // Without hints a working thread reads Working, with the time it has been at it.
  const plain = card({ state: "working", agents: 1 }, {});
  expect(plain.pill).toMatchObject({ label: "Working", since: now });
});

test("a linked pull request stays available when the thread has no feature branch", () => {
  for (const branch of [null, "main", "master"]) {
    const local = entry("t", { state: "done" }, now, {
      details: { branch, linkedPr: { number: 18, state: "open" } },
    });
    const card = threadCard(input({ entry: local, details: cardDetails(local, undefined) }));
    expect(card.pr).toBe(18);
    if (branch) expect(card.branch?.name).toBe(branch);
    else expect(card.branch).toBeUndefined();
  }
});

test("another surface naming a thread uses its sidebar row's word", () => {
  const live = (status: Parameters<typeof entry>[1], hints: object) =>
    entry("t", status, now, { live: { provider: "claude", ...hints } });
  const watching = live(
    { state: "waiting", on: "background_task" },
    { watching: [{ id: "relay", title: "bun run dev:relay" }] },
  );
  expect(threadRowStatus(watching, now, "en-US")).toBe("Background · 1");
  const asking = live(
    { state: "needs_you", interactions: 1 },
    { asking: [{ id: "a", kind: "approval" }] },
  );
  expect(threadRowStatus(asking, now, "en-US")).toBe("Approve");
  expect(threadRowStatus(entry("t", { state: "waiting", on: "network" }, now), now)).toBe(
    "Waiting",
  );
  expect(threadRowStatus(entry("t", { state: "done" }, now), now)).toBe("Done");
});
