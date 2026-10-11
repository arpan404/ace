import { expect, test } from "vitest";
import { fakeGh, sha, nextSha } from "./testing/fixtures.ts";
const signal = () => new AbortController().signal;
const pr = {
  id: "PR_7",
  number: 7,
  headRefOid: sha,
  state: "OPEN",
  isDraft: false,
  mergeStateStatus: "BLOCKED",
  reviewDecision: "REVIEW_REQUIRED",
  statusCheckRollup: { state: "SUCCESS" },
  autoMergeRequest: null,
  mergeQueueEntry: null,
  viewerCanEnableAutoMerge: true,
  viewerCanDisableAutoMerge: false,
};
const armed = {
  mergeMethod: "SQUASH",
  enabledAt: "2026-10-11T00:00:00Z",
  enabledBy: { login: "octo" },
};
const queue = {
  id: "QUEUE_7",
  state: "AWAITING_CHECKS",
  position: 2,
  enqueuedAt: "2026-10-11T00:00:00Z",
};
const read = (overrides: Record<string, unknown> = {}) => ({
  body: {
    data: { repository: { viewerPermission: "WRITE", pullRequest: { ...pr, ...overrides } } },
  },
});

test("green CI with outstanding reviews still exposes GitHub's auto-merge capability and blockers", async () => {
  const f = await fakeGh({ graphql: [read()] });
  try {
    expect(await f.forge.prMergeState(7, signal())).toMatchObject({
      canEnable: true,
      autoMerge: null,
      checksState: "SUCCESS",
      blockers: expect.arrayContaining(["Required reviews are outstanding."]),
    });
  } finally {
    await f.cleanup();
  }
});
test("enable and cancel return GitHub state and a subsequent external disablement stays disabled", async () => {
  const f = await fakeGh({
    graphql: [
      read(),
      { body: { data: { enablePullRequestAutoMerge: { clientMutationId: null } } } },
      read({ autoMergeRequest: armed, viewerCanDisableAutoMerge: true }),
      read({ autoMergeRequest: armed, viewerCanDisableAutoMerge: true }),
      { body: { data: { disablePullRequestAutoMerge: { clientMutationId: null } } } },
      read(),
      read(),
    ],
  });
  try {
    expect(await f.forge.changeMergeState(7, sha, "enable", "squash", signal())).toMatchObject({
      autoMerge: { method: "SQUASH", actor: "octo" },
    });
    expect(await f.forge.changeMergeState(7, sha, "disable", "squash", signal())).toMatchObject({
      autoMerge: null,
    });
    expect(await f.forge.prMergeState(7, signal())).toMatchObject({ autoMerge: null });
    const requests = await f.requests();
    expect(requests[1]?.body).toMatchObject({
      variables: { input: { pullRequestId: "PR_7", expectedHeadOid: sha, mergeMethod: "SQUASH" } },
    });
    expect(requests[4]?.body).toMatchObject({
      query: expect.stringContaining("disablePullRequestAutoMerge(input:$input)"),
      variables: { input: { pullRequestId: "PR_7" } },
    });
  } finally {
    await f.cleanup();
  }
});
test("queue cancellation is separate from auto-merge cancellation and observes queue ejection", async () => {
  const f = await fakeGh({
    graphql: [
      read({ mergeQueueEntry: queue }),
      { body: { data: { dequeuePullRequest: { clientMutationId: null } } } },
      read(),
    ],
  });
  try {
    expect(await f.forge.prMergeState(7, signal())).toMatchObject({
      queue: { state: "AWAITING_CHECKS", position: 2 },
      canDequeue: true,
    });
  } finally {
    await f.cleanup();
  }
  const cancel = await fakeGh({
    graphql: [
      read({ mergeQueueEntry: queue }),
      { body: { data: { dequeuePullRequest: { clientMutationId: null } } } },
      read(),
    ],
  });
  try {
    expect(
      (await cancel.forge.changeMergeState(7, sha, "dequeue", "squash", signal())).queue,
    ).toBeNull();
    expect((await cancel.requests())[1]?.body).toMatchObject({
      query: expect.stringContaining("dequeuePullRequest(input:$input)"),
      variables: { input: { id: "PR_7" } },
    });
  } finally {
    await cancel.cleanup();
  }
});
test("a changed head prevents a cancellation write", async () => {
  const f = await fakeGh({
    graphql: [
      read({ headRefOid: nextSha, autoMergeRequest: armed, viewerCanDisableAutoMerge: true }),
    ],
  });
  try {
    await expect(
      f.forge.changeMergeState(7, sha, "disable", "squash", signal()),
    ).rejects.toMatchObject({ kind: "conflict" });
    expect(await f.requests()).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});
test("a lost acknowledgement is reconciled without repeating the enable mutation", async () => {
  const f = await fakeGh({
    graphql: [read(), { raw: "lost acknowledgement" }, read({ mergeQueueEntry: queue })],
  });
  try {
    expect(await f.forge.changeMergeState(7, sha, "enable", "squash", signal())).toMatchObject({
      autoMerge: null,
      queue: { state: "AWAITING_CHECKS" },
    });
    expect(await f.requests()).toHaveLength(3);
  } finally {
    await f.cleanup();
  }
});
test.each(["FORBIDDEN", "RATE_LIMITED", "UNSUPPORTED"])(
  "%s failure remains visible if a fresh read does not confirm the write",
  async (type) => {
    const f = await fakeGh({
      graphql: [
        read(),
        { body: { errors: [{ type, message: "GitHub rejected this mutation." }] }, code: 1 },
        read(),
      ],
    });
    try {
      await expect(
        f.forge.changeMergeState(7, sha, "enable", "squash", signal()),
      ).rejects.toMatchObject({
        kind:
          type === "FORBIDDEN"
            ? "forbidden"
            : type === "RATE_LIMITED"
              ? "rate_limit"
              : "unsupported",
      });
    } finally {
      await f.cleanup();
    }
  },
);

test("a nonzero GraphQL read reports the host's forbidden classification", async () => {
  const f = await fakeGh({
    graphql: [{ body: { errors: [{ type: "FORBIDDEN", message: "Access denied." }] }, code: 1 }],
  });
  try {
    await expect(f.forge.prMergeState(7, signal())).rejects.toMatchObject({ kind: "forbidden" });
  } finally {
    await f.cleanup();
  }
});

test("a failed CLI exit without a GraphQL error envelope remains a CLI failure", async () => {
  const f = await fakeGh({ graphql: [{ ...read(), code: 1 }] });
  try {
    await expect(f.forge.prMergeState(7, signal())).rejects.toMatchObject({ kind: "cli" });
  } finally {
    await f.cleanup();
  }
});
