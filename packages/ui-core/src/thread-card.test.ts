import { expect, test } from "vitest";
import { entry } from "./test-entries.fixture.ts";
import { cardDetails, threadCard, type ThreadCardInput } from "./thread-card.ts";

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

test("a thread held at its account's usage limit is marked in the list, unlike a waiting one", () => {
  const limited = threadCard(input({ entry: entry("t", { state: "limited" }, now) }));
  expect(limited.status).toEqual({ label: "Limited", tone: "waiting", mark: "limited" });
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
  expect(card.branch).toEqual({ name: "fix/retry", pr: 188, worktree: true });
  expect(card.machine).toBe("build-box");
  expect(cardDetails(remote, "build-box.local").machine).toBeUndefined();
});

test("a thread with no branch yet shows none rather than an empty one", () => {
  const detached = entry("t", { state: "done" }, now, { details: { branch: null } });
  expect(
    threadCard(input({ entry: detached, details: cardDetails(detached, undefined) })).branch,
  ).toBeUndefined();
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
  expect(unread.dimmed).toBe(false);
  const read = threadCard(
    input({ entry: entry("t", { state: "done" }, now - 1000, { readAt: now, unread: false }) }),
  );
  expect(read.pill).toBeUndefined();
  expect(read.dimmed).toBe(true);
});

test("trouble and requests keep their pill whether read or not", () => {
  const read = { readAt: now, unread: false };
  for (const [status, label] of [
    [{ state: "needs_you", interactions: 1 }, "Needs you"],
    [{ state: "failed" }, "Failed"],
    [{ state: "limited" }, "Limited"],
    [{ state: "waiting", on: "rate_limit" }, "Waiting"],
  ] as const) {
    const card = threadCard(input({ entry: entry("t", status, now - 1000, read) }));
    expect(card.pill?.label).toBe(label);
    expect(card.dimmed).toBe(false);
  }
});

test("a settled row is quiet and shows no pill", () => {
  const card = threadCard(
    input({ entry: entry("t", { state: "done" }, now - 1000), settled: true }),
  );
  expect(card.pill).toBeUndefined();
  expect(card.dimmed).toBe(true);
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
