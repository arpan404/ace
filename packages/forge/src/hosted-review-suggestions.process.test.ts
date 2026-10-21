import { expect, test } from "vitest";
import { fakeGh, nextSha, reviewFixtures, sha, type Fixtures } from "./testing/fixtures.ts";
import { WriteDispatch } from "./index.ts";
const signal = () => new AbortController().signal;
const allowed = () => true;
const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const head = (at: string) => ({
  body: { number: 7, head: { sha: at, ref: "feat/fix", repo: { full_name: "fork/ace" } } },
});
const original = "let a=1\nlet a = 1\nkeep\nremove me\n";
const applied = "const a = 1;\nkeep\n";
const comments = [
  {
    id: 21,
    path: "src/main.ts",
    start_line: 1,
    line: 2,
    side: "RIGHT",
    body: "Tighten this\n\n```suggestion\nconst a = 1;\n```",
    user: { login: "reviewer" },
  },
  {
    id: 22,
    path: "src/main.ts",
    start_line: null,
    line: 4,
    side: "RIGHT",
    body: "```suggestion\n```",
    user: { login: "reviewer" },
  },
  {
    id: 23,
    path: "src/main.ts",
    start_line: null,
    line: null,
    side: "RIGHT",
    body: "```suggestion\nold\n```",
    user: { login: "reviewer" },
  },
];
function suggestionFixtures(): Fixtures {
  return {
    ...reviewFixtures(),
    "repos/octo/ace/pulls/7": [head(sha), head(nextSha)],
    "repos/octo/ace/pulls/7/comments?per_page=100": [{ body: comments }],
    [`repos/octo/ace/contents/src/main.ts?ref=${sha}`]: [
      { body: { type: "file", encoding: "base64", content: base64(original) } },
    ],
    [`repos/octo/ace/contents/src/main.ts?ref=${nextSha}`]: [
      { body: { type: "file", encoding: "base64", content: base64(applied) } },
    ],
    [`repos/octo/ace/commits/${nextSha}`]: [{ body: { sha: nextSha, parents: [{ sha }] } }],
    "graphql:createCommitOnBranch": [
      { body: { data: { createCommitOnBranch: { commit: { oid: nextSha } } } } },
    ],
  };
}
const batch = {
  kind: "suggestions.apply" as const,
  headSha: sha,
  commentIds: [22, 21],
  message: "Apply suggestions from code review\n\nTwo fixes.",
};

test("a batch of suggestions lands as one commit on the head branch the reviewer saw", async () => {
  const f = await fakeGh(suggestionFixtures());
  try {
    await f.forge.reviews.write(7, batch, [], "apply", signal(), allowed);
    const commit = (await f.requests()).find(
      (r) => r.path === "graphql" && JSON.stringify(r.body ?? null).includes("createCommitOnBranch"),
    );
    expect(commit?.body).toMatchObject({
      variables: {
        input: {
          branch: { repositoryNameWithOwner: "fork/ace", branchName: "feat/fix" },
          expectedHeadOid: sha,
          message: { headline: "Apply suggestions from code review", body: "Two fixes." },
          fileChanges: { additions: [{ path: "src/main.ts", contents: base64(applied) }] },
        },
      },
    });
    // The head is now that commit, one on top of the reviewed head, with the suggested text.
    expect(await f.forge.reviews.reconcile(7, batch, "apply", signal())).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test("a head that moved since the review refuses before any commit is sent", async () => {
  const fixtures = suggestionFixtures();
  fixtures["repos/octo/ace/pulls/7"] = [head(nextSha)];
  const f = await fakeGh(fixtures);
  const dispatch = new WriteDispatch();
  try {
    await expect(
      f.forge.reviews.write(7, batch, [], "apply", signal(), allowed, dispatch),
    ).rejects.toMatchObject({ kind: "head_moved" });
    expect((await f.requests()).some((r) => JSON.stringify(r.body ?? null).includes("mutation"))).toBe(
      false,
    );
  } finally {
    await f.cleanup();
  }
});

test("a suggestion on an outdated line is refused rather than applied to the wrong lines", async () => {
  const f = await fakeGh(suggestionFixtures());
  try {
    await expect(
      f.forge.reviews.write(7, { ...batch, commentIds: [23] }, [], "apply", signal(), allowed),
    ).rejects.toMatchObject({ kind: "conflict" });
    expect((await f.requests()).some((r) => JSON.stringify(r.body ?? null).includes("mutation"))).toBe(
      false,
    );
  } finally {
    await f.cleanup();
  }
});

test("GitHub refusing a commit because the branch moved is a definite failure, not an uncertain one", async () => {
  const fixtures = suggestionFixtures();
  fixtures["graphql:createCommitOnBranch"] = [
    {
      body: {
        data: { createCommitOnBranch: null },
        errors: [{ type: "STALE_DATA", message: "Expected branch to point to a" }],
      },
    },
  ];
  const f = await fakeGh(fixtures);
  const dispatch = new WriteDispatch();
  try {
    await expect(
      f.forge.reviews.write(7, batch, [], "apply", signal(), allowed, dispatch),
    ).rejects.toMatchObject({ kind: "conflict" });
    expect(dispatch.definitelyFailed).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test("an unchanged head reconciles as not applied", async () => {
  const fixtures = suggestionFixtures();
  fixtures["repos/octo/ace/pulls/7"] = [head(sha)];
  const f = await fakeGh(fixtures);
  try {
    expect(await f.forge.reviews.reconcile(7, batch, "apply", signal())).toBe(false);
  } finally {
    await f.cleanup();
  }
});
