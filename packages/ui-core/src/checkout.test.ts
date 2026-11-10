import type { ForgePrStatus, ThreadDetails } from "@ace/protocol";
import { expect, test } from "vitest";
import { checkoutNote, checkoutOf, nextGitStep } from "./checkout.ts";

const repository = { forge: "github", host: "github.com", owner: "acme", name: "relay" } as const;
const details = (patch: Partial<ThreadDetails> = {}): ThreadDetails => ({
  mode: "worktree",
  worktree: "/Users/dev/relay",
  branch: "fix/replay-cursor",
  baseBranch: "main",
  head: "a".repeat(40),
  ahead: 0,
  behind: 0,
  repository,
  diff: { files: 0, additions: 0, deletions: 0 },
  ...patch,
});
const link = (number: number, state: "open" | "draft" | "merged" | "closed" = "open") => ({
  linkedPrs: [
    {
      number,
      state,
      repo: repository,
      url: `https://github.com/acme/relay/pull/${number}`,
      updatedAt: 1,
    },
  ],
});
const step = (patch: Partial<ThreadDetails>, status?: ForgePrStatus | null) => {
  const checkout = checkoutOf(details(patch), status);
  if (!checkout) throw new Error("expected a checkout");
  return nextGitStep(checkout);
};

test("nothing is known about a thread whose checkout the daemon hasn't read", () => {
  expect(checkoutOf(undefined)).toBeUndefined();
  expect(checkoutOf({ mode: "worktree" })).toBeUndefined();
});

test("a remote PR base keeps its Git ref separate from its forge branch name", () => {
  const checkout = checkoutOf(
    details({
      baseBranch: "origin/release",
      base: { ref: "release", remote: "origin", head: "b".repeat(40), fetch: "fetched" },
    }),
  );
  expect(checkout?.baseBranch).toBe("release");
  expect(checkout?.baseRef).toBe("refs/remotes/origin/release");
});

test("uncommitted changes come first, even with an open PR", () => {
  expect(
    step({
      diff: { files: 3, additions: 20, deletions: 4 },
      ahead: 2,
      ...link(9),
    }),
  ).toEqual({ kind: "commit" });
});

test("committed work the remote lacks is pushed next", () => {
  expect(step({ ahead: 1, ...link(9) })).toEqual({ kind: "push" });
});

test("a clean, pushed branch opens a PR", () => {
  expect(step({})).toEqual({ kind: "create-pr", blocked: undefined });
});

test("an open PR is followed, with the forge's draft state and CI when it answered", () => {
  expect(step(link(9))).toMatchObject({
    kind: "pr",
    pr: { number: 9, state: "open", url: "https://github.com/acme/relay/pull/9" },
  });
  const status = {
    ref: { repository, number: 9 },
    title: "Fix replay cursor",
    url: "https://github.com/acme/relay/pull/9",
    headSha: "a".repeat(40),
    state: "draft",
    mergeability: "mergeable",
    ci: "pending",
    checks: [],
    comments: [],
    reviewThreads: [],
    raw: {},
  } satisfies ForgePrStatus;
  expect(step(link(9), status)).toMatchObject({
    kind: "pr",
    pr: { number: 9, state: "draft", ci: "pending", title: "Fix replay cursor" },
  });
});

test("a merged PR starts the walk again", () => {
  expect(step(link(9, "merged"))).toEqual({
    kind: "create-pr",
    blocked: undefined,
  });
});

test("a PR can't be opened from the base branch or without a forge remote", () => {
  expect(step({ branch: "main" })).toMatchObject({ kind: "create-pr", blocked: /on main/ });
  expect(step({ repository: undefined })).toMatchObject({
    kind: "create-pr",
    blocked: /no GitHub or GitLab remote/,
  });
  expect(step({ branch: null })).toMatchObject({ kind: "create-pr", blocked: /detached/ });
});

test("only the thread's links name its PR, never the legacy single link", () => {
  expect(step({ linkedPr: { number: 188, state: "open" } })).toEqual({
    kind: "create-pr",
    blocked: undefined,
  });
});

test("a checkout with no recorded base never guesses one, and can still open a PR", () => {
  const checkout = checkoutOf(details({ baseBranch: undefined, branch: "main" }));
  expect(checkout?.baseBranch).toBeUndefined();
  expect(checkout?.baseRef).toBeUndefined();
  // Without a known base, being on "main" says nothing about where a PR would merge.
  expect(checkout && nextGitStep(checkout)).toEqual({ kind: "create-pr", blocked: undefined });
});

test("GitLab checkouts explain the unsupported forge before creating a PR", () => {
  expect(
    step({ repository: { ...repository, forge: "gitlab", host: "gitlab.com" } }),
  ).toMatchObject({
    kind: "create-pr",
    blocked: /^Creating GitLab merge requests isn't supported yet/,
  });
});

const note = (patch: Partial<ThreadDetails>) => {
  const checkout = checkoutOf(details(patch));
  if (!checkout) throw new Error("expected a checkout");
  return checkoutNote(checkout);
};

test("the sync note says what the remote lacks and what it has that the checkout doesn't", () => {
  expect(note({ ahead: 2 })).toBe("2 commits not pushed");
  expect(note({ behind: 1 })).toBe("1 commit to pull");
  expect(note({ ahead: 1, behind: 3 })).toBe("1 commit not pushed · 3 to pull");
  expect(note({})).toBeUndefined();
});

test.each(["gitbucket", "bitbucket", "gitea", "forgejo"] as const)(
  "%s checkouts cannot create a GitHub PR",
  (forge) => {
    expect(step({ repository: { ...repository, forge, host: "git.example.com" } })).toMatchObject({
      kind: "create-pr",
      blocked: /isn't supported yet/,
    });
  },
);

test("linking existing Origin and GitLab reviews does not require create permissions or a feature branch", async () => {
  const { linkPrBlocker } = await import("./checkout.ts");
  for (const forge of ["origin", "gitlab"] as const) {
    const checkout = checkoutOf(
      details({ repository: { ...repository, forge }, branch: "main", baseBranch: "main" }),
    );
    if (!checkout) throw new Error("Expected checkout");
    expect(linkPrBlocker(checkout)).toBeUndefined();
    expect(nextGitStep(checkout)).toMatchObject({ kind: "create-pr", blocked: expect.any(String) });
  }
});

test("a status from another host cannot change a linked review with the same name and number", () => {
  const status: ForgePrStatus = {
    ref: { repository: { ...repository, forge: "origin", host: "origin.cursor.com" }, number: 9 },
    title: "Other review",
    raw: {},
    url: "https://cursor.com/codebase/acme/relay/pull/9",
    headSha: "a".repeat(40),
    state: "merged",
    mergeability: "unknown",
    ci: "unknown",
    checks: [],
    comments: [],
    reviewThreads: [],
  };
  expect(checkoutOf(details(link(9)), status)?.pr).toMatchObject({
    state: "open",
    repo: repository,
  });
});

test("a checkout can create reviews when its repository declaration enables creation", () => {
  const checkout = checkoutOf(details({ repository: { ...repository, forge: "gitlab" } }));
  if (!checkout) throw new Error("Expected checkout");
  expect(nextGitStep(checkout, { capabilities: ["reviews.create"] })).toEqual({
    kind: "create-pr",
    blocked: undefined,
  });
  expect(nextGitStep(checkout, { capabilities: [] })).toMatchObject({
    blocked: expect.any(String),
  });
});

test("the mobile checkout retains the PR link without a merge action when merging is unsupported", async () => {
  const { changesNextStep } = await import("./mobile-changes.ts");
  const linked = details(link(9));
  expect(
    changesNextStep(linked, undefined, undefined, { capabilities: ["reviews.read"] }),
  ).toMatchObject({
    kind: "none",
    pr: { number: 9 },
  });
  expect(
    changesNextStep(
      details({ repository: { ...repository, forge: "gitlab" } }),
      undefined,
      undefined,
      { capabilities: ["reviews.create"] },
    ),
  ).toMatchObject({
    kind: "create-pr",
    blocked: null,
  });
});
