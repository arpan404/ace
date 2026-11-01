import { expect, test } from "vitest";
import { Command, Thread, type LinkedPullRequest, type ThreadStatus } from "@ace/protocol";
import { organizationDecision, settleDecision } from "./organization.ts";
import { updateThread } from "./index.ts";

const at = 10 * 86_400_000;
const later = at + 7 * 86_400_000;
const policy = { hours: 0, merged: true, closed: false };
const working: ThreadStatus = { state: "working", agents: 1 };
const linked = (extra: Partial<LinkedPullRequest> = {}): LinkedPullRequest => ({
  number: 7,
  state: "open",
  repo: { forge: "github", host: "github.com", owner: "owner", name: "repo" },
  url: "https://github.com/owner/repo/pull/7",
  updatedAt: 100,
  head: "a".repeat(40),
  checks: "pending",
  ...extra,
});
const thread = (extra: Partial<Thread> = {}) =>
  Thread.parse({
    provider: "codex",
    id: "thread",
    workspaceId: "workspace",
    title: "Work",
    createdAt: 1,
    updatedAt: 1,
    status: working,
    ...extra,
  });

/** Snooze `subject` as the daemon would, applying the decision to it. */
function snooze(subject: Thread, wake: "needs_you" | "pr" | undefined) {
  const command = Command.parse({
    id: "c1",
    deviceId: "device",
    payload: { type: "thread.snooze", threadId: "thread", until: later, ...(wake ? { wake } : {}) },
  });
  const decision = organizationDecision(subject, command, at);
  if (typeof decision === "string") return decision;
  const next = structuredClone(subject);
  updateThread(next, { seq: 1, at, threadId: subject.id, payload: decision } as never);
  return next;
}

/** Whether the organizer's next pass on `subject` ends its snooze. */
const wakes = (subject: Thread) => settleDecision(subject, policy, at + 1).snoozedUntil === null;

test.each<[string, ThreadStatus]>([
  ["asks for an approval", { state: "needs_you", interactions: 1 }],
  ["fails", { state: "failed" }],
  ["finishes", { state: "done" }],
  ["hits a limit", { state: "limited" }],
])("a thread snoozed until it needs you wakes when it %s", (_name, status) => {
  const snoozed = snooze(thread(), "needs_you");
  if (typeof snoozed === "string") throw new Error(snoozed);
  expect(wakes(snoozed)).toBe(false);
  expect(wakes({ ...snoozed, status: { state: "waiting", on: "background_task" } })).toBe(false);
  const woken = settleDecision({ ...snoozed, status }, policy, at + 1);
  expect(woken).toMatchObject({ snoozedUntil: null, snoozeWake: null });
});

test("a thread snoozed until it needs you wakes when its queue needs recovery", () => {
  const snoozed = snooze(thread(), "needs_you");
  if (typeof snoozed === "string") throw new Error(snoozed);
  const queue = { revision: 2, paused: true, reason: "not_sent", resumeAt: null, pendingCount: 1 };
  expect(wakes(Thread.parse({ ...snoozed, queue }))).toBe(true);
});

test("until it needs you is refused for a thread that isn't working", () => {
  expect(snooze(thread({ status: { state: "done" } }), "needs_you")).toBe("snooze_not_live");
});

test("a snooze to a time stays asleep through a request and ends at its time", () => {
  const snoozed = snooze(thread(), undefined);
  if (typeof snoozed === "string") throw new Error(snoozed);
  const asking: Thread = { ...snoozed, status: { state: "needs_you", interactions: 1 } };
  expect(wakes(asking)).toBe(false);
  expect(settleDecision(asking, policy, later).snoozedUntil).toBeNull();
});

test.each<[string, Partial<LinkedPullRequest>]>([
  ["a review or comment", { updatedAt: 200 }],
  ["a push", { head: "b".repeat(40), updatedAt: 200 }],
  ["checks finishing", { checks: "passed" }],
  ["a merge", { state: "merged", updatedAt: 200 }],
])("a thread snoozed until the PR changes wakes on %s", (_name, change) => {
  const snoozed = snooze(thread({ details: { linkedPrs: [linked()] } }), "pr");
  if (typeof snoozed === "string") throw new Error(snoozed);
  // Its own work going on, or finishing, doesn't wake it.
  expect(wakes({ ...snoozed, status: { state: "done" } })).toBe(false);
  expect(wakes({ ...snoozed, details: { linkedPrs: [linked()] } })).toBe(false);
  expect(wakes({ ...snoozed, details: { linkedPrs: [linked(change)] } })).toBe(true);
});

test("until the PR changes needs a pull request the forge has confirmed", () => {
  expect(snooze(thread(), "pr")).toBe("snooze_no_pr");
  expect(
    snooze(thread({ details: { linkedPrs: [linked({ unverified: true, updatedAt: 0 })] } }), "pr"),
  ).toBe("snooze_no_pr");
});

test("waking, settling or snoozing to a time drops the event a snooze waited for", () => {
  const snoozed = snooze(thread(), "needs_you");
  if (typeof snoozed === "string") throw new Error(snoozed);
  const timed = snooze(snoozed, undefined);
  if (typeof timed === "string") throw new Error(timed);
  expect(timed.snoozeWake).toBeUndefined();
  const wake = organizationDecision(
    snoozed,
    Command.parse({
      id: "c2",
      deviceId: "device",
      payload: { type: "thread.snooze", threadId: "thread", until: null },
    }),
    at,
  );
  expect(wake).toMatchObject({ changes: { snoozedUntil: null, snoozeWake: null } });
  const settle = organizationDecision(
    { ...snoozed, status: { state: "done" } },
    Command.parse({
      id: "c3",
      deviceId: "device",
      payload: { type: "thread.settle", threadId: "thread" },
    }),
    at,
  );
  expect(settle).toMatchObject({ changes: { snoozedUntil: null, snoozeWake: null } });
});
