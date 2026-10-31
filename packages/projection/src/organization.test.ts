import { expect, test } from "vitest";
import { Command, Thread, type LinkedPullRequest } from "@ace/protocol";
import { organizationDecision, settleDecision } from "./organization.ts";

const at = 10 * 86_400_000;
const policy = { hours: 24, merged: true, closed: false };
const pr = (number: number, state: LinkedPullRequest["state"]): LinkedPullRequest => ({
  number,
  state,
  repo: { forge: "github", host: "github.com", owner: "owner", name: "repo" },
  url: `https://github.com/owner/repo/pull/${number}`,
  updatedAt: 1,
});
const thread = (extra: Partial<Thread> = {}) =>
  Thread.parse({
    provider: "codex",
    id: "thread",
    workspaceId: "workspace",
    title: "Work",
    createdAt: 1,
    updatedAt: 1,
    status: { state: "done" },
    ...extra,
  });

test.each(["open", "draft", "closed"] as const)(
  "a merged PR cannot settle a thread with another %s PR, even after inactivity",
  (state) => {
    const changes = settleDecision(
      thread({ details: { linkedPrs: [pr(1, "merged"), pr(2, state)] } }),
      policy,
      at,
    );
    expect(changes.settledAt).toBeUndefined();
    expect(changes.autoSettleAt).toBeNull();
  },
);

test("all linked PRs merging settles the thread", () => {
  expect(
    settleDecision(
      thread({ details: { linkedPrs: [pr(1, "merged"), pr(2, "merged")] } }),
      policy,
      at,
    ),
  ).toMatchObject({ settledAt: at, settledReason: "pr_merged" });
});

test("an empty authoritative PR list does not fall back to a stale legacy merge", () => {
  expect(
    settleDecision(
      thread({ details: { linkedPrs: [], linkedPr: { number: 1, state: "merged" } } }),
      { ...policy, hours: 0 },
      at,
    ).settledAt,
  ).toBeUndefined();
});

test("unverified or deleted PR metadata cannot settle a thread", () => {
  for (const flags of [{ unverified: true }, { deleted: true }]) {
    expect(
      settleDecision(
        thread({ details: { linkedPrs: [{ ...pr(1, "merged"), ...flags }] } }),
        policy,
        at,
      ).settledAt,
    ).toBeUndefined();
  }
});

test("disabling auto-settle cancels a pending settle when done", () => {
  const original = thread({ settleWhenDone: true });
  const command = Command.parse({
    id: "off",
    deviceId: "device",
    payload: { type: "thread.autoSettle", threadId: original.id, enabled: false },
  });
  const decision = organizationDecision(original, command, at);
  expect(decision).toMatchObject({
    type: "thread.client.updated",
    changes: { autoSettle: false, settleWhenDone: null },
  });
  expect(
    settleDecision(thread({ autoSettle: false, settleWhenDone: true }), policy, at).settledAt,
  ).toBeUndefined();
});

test.each(["new", "failed"] as const)("an inactive %s thread stays visible", (state) => {
  expect(settleDecision(thread({ status: { state } }), policy, at).settledAt).toBeUndefined();
});

test("a no-PR thread settles at its configured deadline and never when days are disabled", () => {
  const original = thread({ activityAt: at });
  expect(settleDecision(original, policy, at + 86_400_000 - 1).settledAt).toBeUndefined();
  expect(settleDecision(original, policy, at + 86_400_000)).toMatchObject({
    settledReason: "inactivity",
    settledAt: at + 86_400_000,
  });
  expect(settleDecision(original, { ...policy, hours: 0 }, at * 100).settledAt).toBeUndefined();
});

test("reopening a settled PR set does not settle it again, but completing an added PR does", () => {
  const original = thread({ details: { linkedPrs: [pr(1, "merged"), pr(2, "merged")] } });
  const first = settleDecision(original, { ...policy, hours: 0 }, at);
  const reopened = thread({
    ...original,
    prSettled: first.prSettled ?? undefined,
    prSettledKey: first.prSettledKey ?? undefined,
  });
  expect(settleDecision(reopened, { ...policy, hours: 0 }, at + 1).settledAt).toBeUndefined();
  reopened.details = { linkedPrs: [pr(2, "merged"), pr(1, "merged")] };
  expect(settleDecision(reopened, { ...policy, hours: 0 }, at + 1).settledAt).toBeUndefined();
  reopened.details.linkedPrs?.push(pr(3, "open"));
  expect(settleDecision(reopened, policy, at * 10).settledAt).toBeUndefined();
  reopened.details.linkedPrs = [pr(1, "merged"), pr(2, "merged"), pr(3, "merged")];
  expect(settleDecision(reopened, policy, at * 10).settledReason).toBe("pr_merged");
});

test("disabling merge settling still allows the configured inactivity deadline after all PRs merge", () => {
  const original = thread({
    details: { linkedPrs: [pr(1, "merged"), pr(2, "merged")] },
    activityAt: at,
  });
  const daysOnly = { ...policy, merged: false };
  expect(settleDecision(original, daysOnly, at).settledAt).toBeUndefined();
  expect(settleDecision(original, daysOnly, at + 86_400_000).settledReason).toBe("inactivity");
});

test("close settling waits for every PR to merge or close and respects the close setting", () => {
  const original = thread({ details: { linkedPrs: [pr(1, "closed"), pr(2, "open")] } });
  expect(settleDecision(original, { ...policy, closed: true }, at).settledAt).toBeUndefined();
  original.details = { linkedPrs: [pr(1, "closed"), pr(2, "merged")] };
  expect(settleDecision(original, policy, at).settledAt).toBeUndefined();
  expect(settleDecision(original, { ...policy, closed: true }, at).settledReason).toBe("pr_closed");
});
