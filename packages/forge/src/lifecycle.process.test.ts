import { GitHubForge, lifecycleWriteMarker, WriteDispatch } from "./index.ts";
import { expect, test } from "vitest";
import { fakeGh, lifecycleFixtures, lifecycleRecord, repository, sha, nextSha } from "./testing/fixtures.ts";
const signal = () => new AbortController().signal;
const allowed = () => true;
const beforeWrite = new WriteDispatch();

test("editing metadata publishes literal title, description, base and scoped label/user identities atomically", async () => {
  const original = lifecycleRecord();
  const edited = lifecycleRecord({
    title: "Edited title",
    body: "New description",
    baseRefName: "release",
    labels: { nodes: [{ id: "L_2", name: "urgent" }], pageInfo: { hasNextPage: false } },
    assignees: { nodes: [{ id: "U_2", login: "alice" }], pageInfo: { hasNextPage: false } },
  });
  const fixtures = lifecycleFixtures([original, original, original, edited]);
  fixtures["graphql:label(name:"] = [
    {
      body: {
        data: {
          repository: { id: "R_1", l0: { id: "L_2", name: "urgent" } },
          u0: { id: "U_2", login: "alice" },
        },
      },
    },
  ];
  fixtures["graphql:mutation($input:UpdatePullRequestInput!"] = [
    {
      body: {
        data: { updatePullRequest: { clientMutationId: "edit", pullRequest: { headRefOid: sha } } },
      },
    },
  ];
  const f = await fakeGh(fixtures);
  try {
    const state = await f.forge.lifecycle.snapshot(7, signal());
    expect(
      await f.forge.lifecycle.apply(
        7,
        state.version,
        {
          kind: "edit",
          changes: {
            title: "Edited title",
            body: "New description",
            baseBranch: "release",
            labels: ["urgent"],
            assignees: ["alice"],
          },
        },
        "edit",
        signal(),
        allowed,
        beforeWrite,
      ),
    ).toEqual({ outcome: "accepted", headSha: sha });
    const mutation = (await f.requests()).find((r) =>
      JSON.stringify(r.body).includes("mutation($input:UpdatePullRequestInput!"),
    );
    expect(mutation?.body).toMatchObject({
      variables: {
        input: {
          pullRequestId: "PR_7",
          clientMutationId: "edit",
          title: "Edited title",
          body: "New description",
          baseRefName: "release",
          labelIds: ["L_2"],
          assigneeIds: ["U_2"],
        },
      },
    });
  } finally {
    await f.cleanup();
  }
});

test("stale versions and denied lifecycle permissions never produce a remote mutation", async () => {
  for (const denied of [false, true]) {
    const original = lifecycleRecord();
    const changed = lifecycleRecord(denied ? { viewerCanClose: false } : { headRefOid: nextSha });
    const f = await fakeGh(lifecycleFixtures([original, changed]));
    try {
      const state = await f.forge.lifecycle.snapshot(7, signal());
      await expect(
        f.forge.lifecycle.apply(
          7,
          state.version,
          { kind: "close" },
          "close",
          signal(),
          allowed,
          beforeWrite,
        ),
      ).rejects.toMatchObject({ kind: denied ? "forbidden" : "conflict" });
      expect(
        (await f.requests()).some((r) => JSON.stringify(r.body).includes("mutation($input:")),
      ).toBe(false);
    } finally {
      await f.cleanup();
    }
  }
});

test("draft-ready, convert-to-draft, close and reopen publish their observed host state", async () => {
  for (const transition of [
    {
      kind: "ready",
      from: lifecycleRecord({ isDraft: true }),
      to: lifecycleRecord(),
      mutation: "markPullRequestReadyForReview",
    },
    {
      kind: "draft",
      from: lifecycleRecord(),
      to: lifecycleRecord({ isDraft: true }),
      mutation: "convertPullRequestToDraft",
    },
    {
      kind: "close",
      from: lifecycleRecord(),
      to: lifecycleRecord({ state: "CLOSED" }),
      mutation: "closePullRequest",
    },
    {
      kind: "reopen",
      from: lifecycleRecord({ state: "CLOSED", isDraft: true }),
      to: lifecycleRecord({ isDraft: true }),
      mutation: "reopenPullRequest",
    },
  ] as const) {
    const fixtures = lifecycleFixtures([
      transition.from,
      transition.from,
      transition.from,
      transition.to,
    ]);
    fixtures[
      `graphql:mutation($input:${transition.mutation[0]?.toUpperCase()}${transition.mutation.slice(1)}Input!`
    ] = [
      {
        body: {
          data: {
            [transition.mutation]: {
              clientMutationId: "transition",
              pullRequest: { headRefOid: sha },
            },
          },
        },
      },
    ];
    const f = await fakeGh(fixtures);
    try {
      const state = await f.forge.lifecycle.snapshot(7, signal());
      expect(
        await f.forge.lifecycle.apply(
          7,
          state.version,
          { kind: transition.kind },
          "transition",
          signal(),
          allowed,
          beforeWrite,
        ),
      ).toEqual({ outcome: "accepted", headSha: sha });
      expect((await f.forge.lifecycle.snapshot(7, signal())).state).toBe(
        transition.to.state === "CLOSED" ? "closed" : transition.to.isDraft ? "draft" : "open",
      );
      expect(
        (await f.requests()).some((r) =>
          JSON.stringify(r.body).includes(
            `mutation($input:${transition.mutation[0]?.toUpperCase()}${transition.mutation.slice(1)}Input!`,
          ),
        ),
      ).toBe(true);
    } finally {
      await f.cleanup();
    }
  }
});

test("an accepted update-branch request remains pending until its new head includes the selected base", async () => {
  const original = lifecycleRecord();
  const moved = lifecycleRecord({ headRefOid: "c".repeat(40) });
  const fixtures = lifecycleFixtures([original, original, original, original, original, moved]);
  fixtures["graphql:mutation($input:UpdatePullRequestBranchInput!"] = [
    { body: { data: { updatePullRequestBranch: { pullRequest: { headRefOid: sha } } } } },
  ];
  fixtures[`repos/octo/ace/compare/${nextSha}...${moved.headRefOid}`] = [
    { body: { behind_by: 0 } },
  ];
  const f = await fakeGh(fixtures);
  try {
    const state = await f.forge.lifecycle.snapshot(7, signal());
    expect(
      await f.forge.lifecycle.apply(
        7,
        state.version,
        { kind: "update.merge" },
        "update",
        signal(),
        allowed,
        beforeWrite,
      ),
    ).toEqual({ outcome: "pending", headSha: sha });
    expect(
      await f.forge.lifecycle.observe(7, { kind: "update.merge" }, state, "update", signal()),
    ).toEqual({ outcome: "accepted", headSha: moved.headRefOid });
    expect(
      (await f.requests()).find((r) =>
        JSON.stringify(r.body).includes("mutation($input:UpdatePullRequestBranchInput!"),
      )?.body,
    ).toMatchObject({ variables: { input: { expectedHeadOid: sha, updateMethod: "MERGE" } } });
  } finally {
    await f.cleanup();
  }
});

test("a conflicting update reports a changed head and never claims the branch is current", async () => {
  const original = lifecycleRecord();
  const moved = lifecycleRecord({ headRefOid: "c".repeat(40) });
  const fixtures = lifecycleFixtures([original, moved]);
  fixtures[`repos/octo/ace/compare/${nextSha}...${moved.headRefOid}`] = [
    { body: { behind_by: 2 } },
  ];
  const f = await fakeGh(fixtures);
  try {
    const state = await f.forge.lifecycle.snapshot(7, signal());
    expect(
      await f.forge.lifecycle.observe(7, { kind: "update.rebase" }, state, "update", signal()),
    ).toEqual({ outcome: "head_changed", headSha: moved.headRefOid });
  } finally {
    await f.cleanup();
  }
});

test("revert creates a separate draft PR with the reviewed summary and preserves the merged source", async () => {
  const fixtures = lifecycleFixtures([
    lifecycleRecord({ state: "MERGED", mergeCommit: { oid: nextSha } }),
  ]);
  fixtures["graphql:mutation($input:RevertPullRequestInput!"] = [
    { body: { data: { revertPullRequest: { revertPullRequest: { number: 8 } } } } },
  ];
  const f = await fakeGh(fixtures);
  try {
    const state = await f.forge.lifecycle.snapshot(7, signal());
    expect(
      await f.forge.lifecycle.apply(
        7,
        state.version,
        { kind: "revert", title: "Revert Fix build", body: "Undo #7 after review" },
        "revert",
        signal(),
        allowed,
        beforeWrite,
      ),
    ).toMatchObject({ outcome: "accepted", revertPr: { number: 8 } });
    expect((await f.forge.lifecycle.snapshot(7, signal())).state).toBe("merged");
    expect(
      (await f.requests()).find((r) =>
        JSON.stringify(r.body).includes("mutation($input:RevertPullRequestInput!"),
      )?.body,
    ).toMatchObject({
      variables: {
        input: {
          pullRequestId: "PR_7",
          draft: true,
          title: "Revert Fix build",
          body: expect.stringContaining("Undo #7 after review"),
        },
      },
    });
  } finally {
    await f.cleanup();
  }
});

test("unsupported revert and revoked device authority prevent the write", async () => {
  const fixtures = lifecycleFixtures([
    lifecycleRecord({ state: "MERGED", mergeCommit: { oid: nextSha } }),
  ]);
  fixtures["graphql:mutationType:__type"] = [
    { body: { data: { mutationType: { fields: [{ name: "updatePullRequest" }] } } } },
  ];
  const f = await fakeGh(fixtures);
  try {
    const state = await f.forge.lifecycle.snapshot(7, signal());
    expect(state.actions).not.toContain("revert");
    await expect(
      f.forge.lifecycle.apply(
        7,
        state.version,
        { kind: "revert", title: "Revert", body: "Undo" },
        "revert",
        signal(),
        allowed,
        beforeWrite,
      ),
    ).rejects.toMatchObject({ kind: "unsupported" });
    await expect(
      f.forge.lifecycle.apply(
        7,
        state.version,
        { kind: "edit", changes: { title: "Denied" } },
        "edit",
        signal(),
        () => false,
        beforeWrite,
      ),
    ).rejects.toMatchObject({ kind: "cancelled" });
    expect(
      (await f.requests()).some((r) => JSON.stringify(r.body).includes("mutation($input:")),
    ).toBe(false);
  } finally {
    await f.cleanup();
  }
});

test("clearing labels and assignees replaces both sets on the hosted PR", async () => {
  const original = lifecycleRecord();
  const emptied = lifecycleRecord({
    labels: { nodes: [], pageInfo: { hasNextPage: false } },
    assignees: { nodes: [], pageInfo: { hasNextPage: false } },
  });
  const fixtures = lifecycleFixtures([original, original, original, emptied]);
  fixtures["graphql:mutation($input:UpdatePullRequestInput!"] = [
    { body: { data: { updatePullRequest: { pullRequest: { headRefOid: sha } } } } },
  ];
  const f = await fakeGh(fixtures);
  try {
    const before = await f.forge.lifecycle.snapshot(7, signal());
    expect(
      await f.forge.lifecycle.apply(
        7,
        before.version,
        { kind: "edit", changes: { labels: [], assignees: [] } },
        "clear",
        signal(),
        allowed,
        beforeWrite,
      ),
    ).toEqual({ outcome: "accepted", headSha: sha });
    expect((await f.forge.lifecycle.snapshot(7, signal())).metadata).toMatchObject({
      labels: [],
      assignees: [],
    });
    expect(
      (await f.requests()).find((r) =>
        JSON.stringify(r.body).includes("mutation($input:UpdatePullRequestInput!"),
      )?.body,
    ).toMatchObject({ variables: { input: { labelIds: [], assigneeIds: [] } } });
  } finally {
    await f.cleanup();
  }
});

test("a head changed during update verification is reported for review instead of accepted", async () => {
  const original = lifecycleRecord();
  const updated = lifecycleRecord({ headRefOid: "c".repeat(40) });
  const movedAgain = lifecycleRecord({ headRefOid: "d".repeat(40) });
  const fixtures = lifecycleFixtures([original, updated, movedAgain]);
  fixtures[`repos/octo/ace/compare/${nextSha}...${updated.headRefOid}`] = [
    { body: { behind_by: 0 } },
  ];
  const f = await fakeGh(fixtures);
  try {
    const before = await f.forge.lifecycle.snapshot(7, signal());
    expect(
      await f.forge.lifecycle.observe(7, { kind: "update.merge" }, before, "update", signal()),
    ).toEqual({ outcome: "head_changed", headSha: movedAgain.headRefOid });
  } finally {
    await f.cleanup();
  }
});

test("a lost revert response is recovered from the first page of a large PR history", async () => {
  const merged = lifecycleRecord({ state: "MERGED", mergeCommit: { oid: sha } });
  const fixtures = lifecycleFixtures([merged]);
  const path = "repos/octo/ace/pulls?state=all&sort=created&direction=desc&per_page=100";
  fixtures[path] = [
    {
      body: [{ number: 9001, title: "Revert", body: lifecycleWriteMarker("large-revert") }],
      headers: {
        link: `<https://api.github.com/${path}&page=2>; rel="next", <https://api.github.com/${path}&page=91>; rel="last"`,
      },
    },
  ];
  // Complete history is intentionally unavailable; the matching page is enough.
  fixtures[`${path}&page=2`] = [{ status: 503 }];
  const f = await fakeGh(fixtures);
  try {
    const before = await f.forge.lifecycle.snapshot(7, signal());
    expect(
      await f.forge.lifecycle.observe(
        7,
        { kind: "revert", title: "Revert", body: "" },
        before,
        "large-revert",
        signal(),
      ),
    ).toMatchObject({ outcome: "accepted", revertPr: { number: 9001 } });
  } finally {
    await f.cleanup();
  }
});

test("an acknowledged lifecycle write retains uncertainty after the transport reports an identity change", async () => {
  const fixtures = lifecycleFixtures();
  fixtures["graphql:mutation($input:ClosePullRequestInput!"] = [
    { body: { data: { closePullRequest: { pullRequest: { headRefOid: sha } } } } },
  ];
  const f = await fakeGh(fixtures);
  const backend = new GitHubForge({
    repository,
    now: () => 1000,
    runner: async (request) => {
      const result = await f.runner({ ...request, command: f.executable });
      return request.input?.includes("mutation($input:ClosePullRequestInput!")
        ? { ...result, identityChanged: true }
        : result;
    },
  });
  const dispatch = new WriteDispatch();
  try {
    const snapshot = await backend.lifecycle.snapshot(7, signal());
    await expect(
      backend.lifecycle.apply(
        7,
        snapshot.version,
        { kind: "close" },
        "identity-close",
        signal(),
        allowed,
        dispatch,
      ),
    ).rejects.toMatchObject({ kind: "outcome_uncertain" });
    expect(dispatch.definitelyFailed).toBe(false);
  } finally {
    await f.cleanup();
  }
});
