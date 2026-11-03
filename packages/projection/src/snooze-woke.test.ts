import { expect, test } from "vitest";
import {
  Command,
  Thread,
  type LinkedPullRequest,
  type SnoozeWoke,
  type ThreadStatus,
} from "@ace/protocol";
import { organizationDecision, settleDecision } from "./organization.ts";
import { updateThread } from "./index.ts";

const at = 10 * 86_400_000;
const later = at + 7 * 86_400_000;
const policy = { hours: 0, merged: true, closed: false };
const linked = (extra: Partial<LinkedPullRequest> = {}): LinkedPullRequest => ({
  number: 1477,
  state: "open",
  repo: { forge: "github", host: "github.com", owner: "owner", name: "repo" },
  url: "https://github.com/owner/repo/pull/1477",
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
    status: { state: "working", agents: 1 },
    ...extra,
  });

function apply(subject: Thread, payload: unknown, when = at): Thread {
  const command = Command.parse({ id: "c", deviceId: "device", payload });
  const decision = organizationDecision(subject, command, when);
  if (typeof decision === "string") throw new Error(decision);
  const next = structuredClone(subject);
  updateThread(next, { seq: 1, at: when, threadId: subject.id, payload: decision } as never);
  return next;
}

const snooze = (subject: Thread, wake?: "needs_you" | "pr") =>
  apply(subject, {
    type: "thread.snooze",
    threadId: "thread",
    until: later,
    ...(wake && { wake }),
  });

/** What the organizer records as the snooze on `subject` ends at `when`. */
const wokeAt = (subject: Thread, when: number) =>
  settleDecision(subject, policy, when).snoozeWoke as SnoozeWoke | null | undefined;

test("a snooze to a time ends saying its time came, at that time even if the daemon was away", () => {
  const snoozed = snooze(thread());
  expect(wokeAt(snoozed, at + 1)).toBeUndefined();
  expect(wokeAt(snoozed, later + 3_600_000)).toEqual({ on: "time", at: later });
});

test.each<[string, ThreadStatus, string]>([
  ["finished", { state: "done" }, "finished"],
  ["failed", { state: "failed" }, "failed"],
  ["asked for an approval", { state: "needs_you", interactions: 1 }, "asking"],
  ["hit a usage limit", { state: "limited" }, "limited"],
])("until it needs you ends saying the agent %s", (_name, status, outcome) => {
  const snoozed = snooze(thread(), "needs_you");
  expect(wokeAt({ ...snoozed, status }, at + 1)).toEqual({ on: "needs_you", at: at + 1, outcome });
});

test.each<[string, Partial<LinkedPullRequest> | undefined, string]>([
  ["checks failing", { checks: "failed" }, "checks_failed"],
  ["checks passing", { checks: "passed" }, "checks_passed"],
  ["a push", { head: "b".repeat(40), updatedAt: 200 }, "pushed"],
  ["a merge", { state: "merged", updatedAt: 200 }, "merged"],
  ["a review or comment", { updatedAt: 200 }, "updated"],
  ["the PR being unlinked", undefined, "unlinked"],
])("until the PR changes ends naming %s on the PR", (_name, change, expected) => {
  const snoozed = snooze(thread({ details: { linkedPrs: [linked()] } }), "pr");
  const moved = { ...snoozed, details: { linkedPrs: change ? [linked(change)] : [] } };
  expect(wokeAt(moved, at + 1)).toEqual({ on: "pr", at: at + 1, number: 1477, change: expected });
});

test("a draft marked ready wakes saying the PR was updated, never claiming a review", () => {
  const snoozed = snooze(thread({ details: { linkedPrs: [linked({ state: "draft" })] } }), "pr");
  const ready = { ...snoozed, details: { linkedPrs: [linked({ state: "open" })] } };
  expect(wokeAt(ready, at + 1)).toMatchObject({ on: "pr", change: "updated" });
});

test("snoozing again or waking by hand clears the last wake's reason", () => {
  const snoozed = snooze(thread());
  const woken = structuredClone(snoozed);
  updateThread(woken, {
    seq: 2,
    at: later,
    threadId: woken.id,
    payload: { type: "thread.client.updated", changes: settleDecision(snoozed, policy, later) },
  } as never);
  expect(woken.snoozeWoke).toEqual({ on: "time", at: later });
  expect(snooze(woken).snoozeWoke).toBeUndefined();
  expect(
    apply(woken, { type: "thread.snooze", threadId: "thread", until: null }).snoozeWoke,
  ).toBeUndefined();
});

test("a snooze the person ends by hand records no wake", () => {
  const snoozed = snooze(thread());
  const woken = apply(snoozed, { type: "thread.snooze", threadId: "thread", until: null });
  expect(woken.snoozeWoke).toBeUndefined();
  expect(wokeAt(woken, later + 1)).toBeUndefined();
});
