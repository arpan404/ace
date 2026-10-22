import { WriteDispatch } from "./index.ts";
import { expect, test } from "vitest";
import { fakeGh, lifecycleFixtures, lifecycleRecord, nextSha, sha } from "./testing/fixtures.ts";
import {
  closingIssue,
  extraFixtures,
  extraRecord,
  headRef,
} from "./testing/lifecycle-extra-fixtures.ts";
import type { ForgeLifecycleAction } from "@ace/protocol/forge-lifecycle";

const signal = () => new AbortController().signal;
const allowed = () => true;
type Gh = Awaited<ReturnType<typeof fakeGh>>;
const apply = async (f: Gh, action: ForgeLifecycleAction) => {
  const state = await f.forge.lifecycle.snapshot(7, signal());
  return f.forge.lifecycle.apply(
    7,
    state.version,
    action,
    "op-1",
    signal(),
    allowed,
    new WriteDispatch(),
  );
};
const writes = async (f: Gh) =>
  (await f.requests()).filter((r) => {
    const method = r.args[r.args.indexOf("--method") + 1];
    if (method === "GET") return false;
    return r.path !== "graphql" || JSON.stringify(r.body).includes('"query":"mutation');
  });

test("a merged PR's branch is offered for deletion only where GitHub won't delete it itself", async () => {
  const cases = [
    { state: "MERGED", deleteBranchOnMerge: false, offered: true },
    { state: "MERGED", deleteBranchOnMerge: true, offered: false },
    { state: "CLOSED", deleteBranchOnMerge: true, offered: true },
    { state: "OPEN", deleteBranchOnMerge: false, offered: false },
  ];
  for (const { state, deleteBranchOnMerge, offered } of cases) {
    const f = await fakeGh(extraFixtures([extraRecord({ state })], { deleteBranchOnMerge }));
    try {
      const snapshot = await f.forge.lifecycle.snapshot(7, signal());
      expect(snapshot.actions.includes("branch.delete"), `${state} ${deleteBranchOnMerge}`).toBe(
        offered,
      );
    } finally {
      await f.cleanup();
    }
  }
});

test("the default branch, a fork's branch and a deleted branch are never offered for deletion", async () => {
  for (const [record, defaultBranch] of [
    [extraRecord({ state: "MERGED", headRefName: "main", headRef: { name: "main" } }), "main"],
    [extraRecord({ state: "MERGED", isCrossRepository: true }), "main"],
    [extraRecord({ state: "MERGED", headRef: null }), "main"],
  ] as const) {
    const f = await fakeGh(extraFixtures([record], { defaultBranch }));
    try {
      expect((await f.forge.lifecycle.snapshot(7, signal())).actions).not.toContain(
        "branch.delete",
      );
    } finally {
      await f.cleanup();
    }
  }
});

test("deleting the head branch removes it on GitHub and reports it gone", async () => {
  const merged = extraRecord({ state: "MERGED" });
  const f = await fakeGh({
    ...extraFixtures([merged, merged, merged, extraRecord({ state: "MERGED", headRef: null })]),
    ...headRef("feature/fix"),
    "repos/octo/ace/git/refs/heads/feature/fix": [{ status: 204, raw: "" }],
  });
  try {
    expect(await apply(f, { kind: "branch.delete" })).toEqual({
      outcome: "accepted",
      headSha: sha,
    });
    const sent = await writes(f);
    expect(sent.map((r) => [r.path, r.args[r.args.indexOf("--method") + 1]])).toEqual([
      ["repos/octo/ace/git/refs/heads/feature/fix", "DELETE"],
    ]);
    const after = await f.forge.lifecycle.snapshot(7, signal());
    expect(after.headBranch?.exists).toBe(false);
    expect(after.actions).toContain("branch.restore");
  } finally {
    await f.cleanup();
  }
});

test("a branch that moved past the PR's head is kept: nothing is deleted", async () => {
  const merged = extraRecord({ state: "MERGED" });
  const f = await fakeGh({
    ...extraFixtures([merged]),
    ...headRef("feature/fix", nextSha),
  });
  try {
    await expect(apply(f, { kind: "branch.delete" })).rejects.toMatchObject({
      kind: "head_moved",
    });
    expect(await writes(f)).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

test("restoring a deleted branch recreates it at the PR's head commit", async () => {
  const deleted = extraRecord({ state: "CLOSED", headRef: null });
  const f = await fakeGh({
    ...extraFixtures([deleted, deleted, deleted, extraRecord({ state: "CLOSED" })]),
    ...headRef("feature/fix", null),
    "repos/octo/ace/git/refs": [
      { status: 201, body: { ref: "refs/heads/feature/fix", object: { sha } } },
    ],
  });
  try {
    expect(await apply(f, { kind: "branch.restore" })).toEqual({
      outcome: "accepted",
      headSha: sha,
    });
    const [write] = await writes(f);
    expect(write?.path).toBe("repos/octo/ace/git/refs");
    expect(write?.body).toEqual({ ref: "refs/heads/feature/fix", sha });
  } finally {
    await f.cleanup();
  }
});

test("locking sends GitHub's reason and the snapshot then reads locked, closed to non-pushers", async () => {
  const open = extraRecord();
  const locked = extraRecord({ locked: true, activeLockReason: "TOO_HEATED" });
  const f = await fakeGh({
    ...extraFixtures([open, open, open, open, locked], { permission: "TRIAGE" }),
    "repos/octo/ace/issues/7/lock": [{ status: 204, raw: "" }],
  });
  try {
    expect((await f.forge.lifecycle.snapshot(7, signal())).actions).toContain("lock");
    expect(await apply(f, { kind: "lock", reason: "too_heated" })).toEqual({
      outcome: "accepted",
      headSha: sha,
    });
    const [write] = await writes(f);
    expect(write?.args).toContain("PUT");
    expect(write?.body).toEqual({ lock_reason: "too heated" });
    const after = await f.forge.lifecycle.snapshot(7, signal());
    // Triage may lock, but only collaborators who can push still comment on a locked PR.
    expect(after.conversation).toEqual({
      locked: true,
      reason: "too_heated",
      viewerCanComment: false,
    });
    expect(after.actions).toContain("unlock");
  } finally {
    await f.cleanup();
  }
});

test("a reader without triage rights is offered neither lock nor milestone", async () => {
  const f = await fakeGh(extraFixtures([extraRecord()], { permission: "READ" }));
  try {
    const snapshot = await f.forge.lifecycle.snapshot(7, signal());
    expect(snapshot.actions).not.toContain("lock");
    expect(snapshot.editableFields).not.toContain("milestone");
  } finally {
    await f.cleanup();
  }
});

test("clearing the milestone patches the PR's issue with null and is observed", async () => {
  const sprint = { number: 3, title: "Sprint 3", state: "OPEN", dueOn: null };
  const before = extraRecord({ milestone: sprint });
  const f = await fakeGh({
    ...extraFixtures([before, before, before, before, extraRecord()]),
    "repos/octo/ace/issues/7": [{ body: { number: 7, milestone: null } }],
  });
  try {
    const snapshot = await f.forge.lifecycle.snapshot(7, signal());
    expect(snapshot.metadata.milestone).toBe(3);
    expect(snapshot.milestone).toEqual({
      number: 3,
      title: "Sprint 3",
      state: "open",
      dueOn: null,
    });
    expect(await apply(f, { kind: "edit", changes: { milestone: null } })).toEqual({
      outcome: "accepted",
      headSha: sha,
    });
    const [write] = await writes(f);
    expect(write?.args).toContain("PATCH");
    expect(write?.body).toEqual({ milestone: null });
  } finally {
    await f.cleanup();
  }
});

test("linking an issue uses GitHub's closing-reference mutation with both node ids", async () => {
  const before = extraRecord();
  const after = extraRecord({ closing: [closingIssue(12)], manual: [closingIssue(12)] });
  const f = await fakeGh({
    ...extraFixtures([before, before, before, after]),
    "graphql:issue(number:$number){id number}": [
      { body: { data: { repository: { issue: { id: "I_12", number: 12 } } } } },
    ],
    "graphql:mutation($input:AddCloseIssueReferencesInput!)": [
      {
        body: {
          data: { addCloseIssueReferences: { clientMutationId: "op-1", issue: { id: "I_12" } } },
        },
      },
    ],
  });
  try {
    expect(await apply(f, { kind: "issue.link", issue: 12 })).toEqual({
      outcome: "accepted",
      headSha: sha,
    });
    const [write] = await writes(f);
    expect(write?.body).toMatchObject({
      variables: { input: { issueId: "I_12", pullRequestIds: ["PR_7"] } },
    });
    const linked = (await f.forge.lifecycle.snapshot(7, signal())).closingIssues;
    expect(linked).toEqual([
      expect.objectContaining({ ref: expect.objectContaining({ number: 12 }), manual: true }),
    ]);
  } finally {
    await f.cleanup();
  }
});

test("an issue linked by a keyword in the body can't be unlinked here: nothing is sent", async () => {
  const f = await fakeGh(extraFixtures([extraRecord({ closing: [closingIssue(5)] })]));
  try {
    const snapshot = await f.forge.lifecycle.snapshot(7, signal());
    const issue = snapshot.closingIssues?.[0];
    expect(issue?.manual).toBe(false);
    await expect(
      apply(f, { kind: "issue.unlink", issue: issue?.ref ?? { repository: snapshot.pr.repository, number: 5 } }),
    ).rejects.toMatchObject({ kind: "forbidden" });
    expect(await writes(f)).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

test("a host that refuses the newer fields still answers the snapshot, without their controls", async () => {
  const fixtures = lifecycleFixtures([lifecycleRecord()]);
  const f = await fakeGh({
    // Listed first, so the document naming the newer fields meets the refusal.
    "graphql:manualClosingIssues": [
      { body: { errors: [{ extensions: { code: "undefinedField" } }] } },
    ],
    ...fixtures,
  });
  try {
    const snapshot = await f.forge.lifecycle.snapshot(7, signal());
    expect(snapshot.state).toBe("open");
    expect(snapshot.conversation).toBeUndefined();
    expect(snapshot.actions).not.toContain("lock");
    expect(snapshot.editableFields).not.toContain("milestone");
  } finally {
    await f.cleanup();
  }
});
