import { expect, test } from "vitest";
import { z } from "zod";
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

for (const action of ["enable", "disable", "dequeue"] as const) {
  test.each([
    ["malformed", true],
    ["mismatched PR", { pullRequest: { id: "PR_8" } }],
  ])(`a %s ${action} acknowledgement cannot confirm an unchanged PR`, async (_label, payload) => {
    const mutation =
      action === "enable"
        ? "enablePullRequestAutoMerge"
        : action === "disable"
          ? "disablePullRequestAutoMerge"
          : "dequeuePullRequest";
    const before = read({
      autoMergeRequest: action === "disable" ? armed : null,
      viewerCanDisableAutoMerge: action === "disable",
      mergeQueueEntry: action === "dequeue" ? queue : null,
    });
    const f = await fakeGh({
      graphql: [before, { body: { data: { [mutation]: payload } } }, before],
    });
    try {
      await expect(
        f.forge.changeMergeState(7, sha, action, "squash", signal()),
      ).rejects.toMatchObject({ kind: "outcome_uncertain" });
      expect((await f.requests())[1]?.body).toMatchObject({
        query: expect.stringContaining(`${mutation}(input:$input){pullRequest{id}}`),
      });
    } finally {
      await f.cleanup();
    }
  });
}

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
      { body: { data: { enablePullRequestAutoMerge: { pullRequest: { id: "PR_7" } } } } },
      read({ autoMergeRequest: armed, viewerCanDisableAutoMerge: true }),
      read({ autoMergeRequest: armed, viewerCanDisableAutoMerge: true }),
      { body: { data: { disablePullRequestAutoMerge: { pullRequest: { id: "PR_7" } } } } },
      read(),
      read(),
    ],
  });
  try {
    await f.forge.changeMergeState(7, sha, "enable", "squash", signal());
    expect(await f.forge.prMergeState(7, signal())).toMatchObject({
      autoMerge: { method: "SQUASH", actor: "octo" },
    });
    await f.forge.changeMergeState(7, sha, "disable", "squash", signal());
    expect(await f.forge.prMergeState(7, signal())).toMatchObject({ autoMerge: null });
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
      { body: { data: { dequeuePullRequest: { pullRequest: { id: "PR_7" } } } } },
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
      { body: { data: { dequeuePullRequest: { pullRequest: { id: "PR_7" } } } } },
      read(),
    ],
  });
  try {
    await cancel.forge.changeMergeState(7, sha, "dequeue", "squash", signal());
    expect((await cancel.forge.prMergeState(7, signal())).queue).toBeNull();
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
test.each(["FORBIDDEN", "RATE_LIMITED", "GRAPHQL_VALIDATION_FAILED"])(
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
              : "invalid_data",
      });
    } finally {
      await f.cleanup();
    }
  },
);

test("a blocked merge names branch protection and ruleset requirements once each", async () => {
  const f = await fakeGh({
    graphql: [
      read({
        statusCheckRollup: { state: "PENDING" },
        baseRef: {
          branchProtectionRule: {
            requiredApprovingReviewCount: 2,
            requiresConversationResolution: true,
            requiresCommitSignatures: true,
            requiresLinearHistory: false,
          },
          rules: {
            nodes: [
              { type: "REQUIRED_SIGNATURES" },
              { type: "REQUIRED_LINEAR_HISTORY" },
              { type: "SOMETHING_GITHUB_ADDS_LATER" },
            ],
          },
        },
      }),
    ],
  });
  try {
    const rules = [
      "2 approving reviews required.",
      "Conversations must be resolved.",
      "Signed commits required.",
      "Linear history required.",
    ];
    expect(await f.forge.prMergeState(7, signal())).toMatchObject({
      rules,
      blockers: ["2 approving reviews required.", "Checks: PENDING.", ...rules.slice(1)],
    });
  } finally {
    await f.cleanup();
  }
});

test("a blocked merge with nothing else to explain it is never shown as mergeable", async () => {
  const f = await fakeGh({ graphql: [read({ reviewDecision: "APPROVED" })] });
  try {
    expect(await f.forge.prMergeState(7, signal())).toMatchObject({
      rules: ["GitHub's branch rules block this merge."],
      blockers: ["GitHub's branch rules block this merge."],
    });
  } finally {
    await f.cleanup();
  }
});

test("branch rules are not claimed for a merge GitHub doesn't block", async () => {
  const f = await fakeGh({
    graphql: [
      read({
        mergeStateStatus: "CLEAN",
        reviewDecision: "APPROVED",
        baseRef: { branchProtectionRule: { requiresCommitSignatures: true }, rules: null },
      }),
    ],
  });
  try {
    expect(await f.forge.prMergeState(7, signal())).toMatchObject({ rules: [], blockers: [] });
  } finally {
    await f.cleanup();
  }
});

const deploy = (environment: unknown, state: string, url: string | null) => ({
  environment,
  state: "ACTIVE",
  latestStatus: { state, environmentUrl: url },
});
test("deployments keep the latest per environment and GitHub's own state words", async () => {
  const f = await fakeGh({
    graphql: [
      read({
        commits: {
          nodes: [
            {
              commit: {
                deployments: {
                  nodes: [
                    deploy("staging", "FAILURE", "https://old.example"),
                    deploy("production", "WAITING_ON_SOMETHING_NEW", ""),
                    deploy(null, "SUCCESS", null),
                    deploy("staging", "SUCCESS", "https://staging.example"),
                  ],
                },
              },
            },
          ],
        },
      }),
    ],
  });
  try {
    expect((await f.forge.prMergeState(7, signal())).deployments).toEqual([
      { environment: "staging", state: "SUCCESS", url: "https://staging.example" },
      { environment: "production", state: "WAITING_ON_SOMETHING_NEW", url: null },
    ]);
  } finally {
    await f.cleanup();
  }
});

test("rule and deployment fields GitHub returns in an unexpected shape don't fail the read", async () => {
  const f = await fakeGh({
    graphql: [
      read({
        mergeQueueEntry: { ...queue, estimatedTimeToMerge: "soon" },
        baseRef: { branchProtectionRule: { requiresCommitSignatures: "yes" }, rules: 4 },
        commits: { nodes: "none" },
      }),
    ],
  });
  try {
    expect(await f.forge.prMergeState(7, signal())).toMatchObject({
      queue: { position: 2, estimatedTimeToMerge: null },
      blockers: ["Required reviews are outstanding.", "Merge queue: AWAITING_CHECKS, position 2."],
      deployments: [],
    });
    expect(await f.requests()).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

test("a host that refuses the extended fields answers with the base fields from then on", async () => {
  const f = await fakeGh({
    graphql: [
      {
        body: { errors: [{ type: "GRAPHQL_VALIDATION_FAILED", message: "Field doesn't exist" }] },
        code: 1,
      },
      read({ mergeQueueEntry: { ...queue, estimatedTimeToMerge: 150 } }),
      read(),
    ],
  });
  try {
    expect(await f.forge.prMergeState(7, signal())).toMatchObject({
      queue: { position: 2, estimatedTimeToMerge: 150 },
      blockers: expect.arrayContaining(["Required reviews are outstanding."]),
    });
    expect(await f.forge.prMergeState(7, signal())).toMatchObject({ queue: null });
    const queries = (await f.requests()).map((request) => JSON.stringify(request.body));
    expect(queries.map((query) => query.includes("deployments"))).toEqual([true, false, false]);
  } finally {
    await f.cleanup();
  }
});

test("a refused read is reported without retrying a smaller query", async () => {
  const f = await fakeGh({
    graphql: [{ body: { errors: [{ type: "RATE_LIMITED", message: "Slow down." }] }, code: 1 }],
  });
  try {
    await expect(f.forge.prMergeState(7, signal())).rejects.toMatchObject({ kind: "rate_limit" });
    expect(await f.requests()).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

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

test("the legacy auto-merge API uses the same authoritative guarded mutation", async () => {
  const f = await fakeGh({
    graphql: [
      read(),
      { body: { data: { enablePullRequestAutoMerge: { pullRequest: { id: "PR_7" } } } } },
      read({ autoMergeRequest: armed }),
    ],
  });
  try {
    await f.forge.enableAutoMerge(7, sha, "squash", signal());
    expect((await f.requests())[1]?.body).toMatchObject({
      query: expect.stringContaining("enablePullRequestAutoMerge(input:$input)"),
      variables: { input: { pullRequestId: "PR_7", expectedHeadOid: sha, mergeMethod: "SQUASH" } },
    });
    expect((await f.requests()).map((request) => request.path)).toEqual(["graphql", "graphql"]);
  } finally {
    await f.cleanup();
  }
});

test.each(["FORBIDDEN", "RATE_LIMITED", "NOT_FOUND"])(
  "a %s read after a lost acknowledgement cannot replace the mutation's uncertainty",
  async (type) => {
    const f = await fakeGh({
      graphql: [
        read(),
        { code: 1, raw: "lost acknowledgement" },
        { code: 1, body: { errors: [{ type, message: "State cannot be read" }] } },
      ],
    });
    try {
      await expect(
        f.forge.changeMergeState(7, sha, "enable", "squash", signal()),
      ).rejects.toMatchObject({ kind: "outcome_uncertain", dispatched: undefined });
      expect(
        (await f.requests()).filter((r) => JSON.stringify(r.body).includes("mutation(")),
      ).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  },
);

test("GitHub's own merge and squash commit text is read for the person to edit", async () => {
  const f = await fakeGh({
    graphql: [
      read({
        mergeHeadline: "Merge pull request #7 from octo/fix",
        mergeBody: "Fix build",
        squashHeadline: "Fix build (#7)",
        squashBody: "* Fix build\n\n* Add test",
      }),
    ],
  });
  try {
    expect((await f.forge.prMergeState(7, signal())).commitMessages).toEqual({
      merge: { title: "Merge pull request #7 from octo/fix", message: "Fix build" },
      squash: { title: "Fix build (#7)", message: "* Fix build\n\n* Add test" },
    });
  } finally {
    await f.cleanup();
  }
});

test("auto-merge carries the edited commit for a squash, and none for a rebase", async () => {
  for (const method of ["squash", "rebase"] as const) {
    const f = await fakeGh({
      graphql: [
        read(),
        { body: { data: { enablePullRequestAutoMerge: { pullRequest: { id: "PR_7" } } } } },
      ],
    });
    try {
      await f.forge.changeMergeState(7, sha, "enable", method, signal(), () => true, undefined, {
        title: "Fix the build (#7)",
        message: "Edited body",
      });
      const input = z
        .object({ variables: z.object({ input: z.record(z.string(), z.unknown()) }) })
        .parse((await f.requests())[1]?.body).variables.input;
      if (method === "squash")
        expect(input).toMatchObject({
          commitHeadline: "Fix the build (#7)",
          commitBody: "Edited body",
        });
      else expect(input).not.toHaveProperty("commitHeadline");
    } finally {
      await f.cleanup();
    }
  }
});

test("a merge sends the edited commit title and message, and a rebase sends neither", async () => {
  for (const method of ["merge", "rebase"] as const) {
    const f = await fakeGh({ "repos/octo/ace/pulls/7/merge": [{ body: { merged: true } }] });
    try {
      await f.forge.merge(7, sha, method, signal(), undefined, {
        title: "Merge #7: fix the build",
        message: "Closes #3",
      });
      const body = (await f.requests())[0]?.body;
      if (method === "merge")
        expect(body).toEqual({
          sha,
          merge_method: "merge",
          commit_title: "Merge #7: fix the build",
          commit_message: "Closes #3",
        });
      else expect(body).toEqual({ sha, merge_method: "rebase" });
    } finally {
      await f.cleanup();
    }
  }
});
