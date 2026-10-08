import type { ForgePrStatus, ThreadDetails } from "@ace/protocol";
import { expect, test } from "vitest";
import { checkoutOf, nextGitStep } from "./checkout.ts";

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
const step = (patch: Partial<ThreadDetails>, status?: ForgePrStatus | null) => {
  const checkout = checkoutOf(details(patch), status);
  if (!checkout) throw new Error("expected a checkout");
  return nextGitStep(checkout);
};

test("nothing is known about a thread whose checkout the daemon hasn't read", () => {
  expect(checkoutOf(undefined)).toBeUndefined();
  expect(checkoutOf({ mode: "worktree" })).toBeUndefined();
});

test("uncommitted changes come first, even with an open PR", () => {
  expect(
    step({
      diff: { files: 3, additions: 20, deletions: 4 },
      ahead: 2,
      linkedPr: { number: 9, state: "open" },
    }),
  ).toEqual({ kind: "commit" });
});

test("committed work the remote lacks is pushed next", () => {
  expect(step({ ahead: 1, linkedPr: { number: 9, state: "open" } })).toEqual({ kind: "push" });
});

test("a clean, pushed branch opens a PR", () => {
  expect(step({})).toEqual({ kind: "create-pr", blocked: undefined });
});

test("an open PR is followed, with the forge's draft state and CI when it answered", () => {
  expect(step({ linkedPr: { number: 9, state: "open", url: "https://x/9" } })).toEqual({
    kind: "pr",
    pr: { number: 9, state: "open", url: "https://x/9" },
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
  expect(step({ linkedPr: { number: 9, state: "open" } }, status)).toMatchObject({
    kind: "pr",
    pr: { number: 9, state: "draft", ci: "pending", title: "Fix replay cursor" },
  });
});

test("a merged PR starts the walk again", () => {
  expect(step({ linkedPr: { number: 9, state: "merged" } })).toEqual({
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

test("a linked PR without an address opens on its repository's forge", () => {
  expect(step({ linkedPr: { number: 188, state: "open" } })).toEqual({
    kind: "pr",
    pr: { number: 188, state: "open", url: "https://github.com/acme/relay/pull/188" },
  });
  const gitlab = { ...repository, forge: "gitlab", host: "gitlab.com" } as const;
  expect(
    checkoutOf(details({ repository: gitlab, linkedPr: { number: 4, state: "open" } }))?.pr?.url,
  ).toBe("https://gitlab.com/acme/relay/-/merge_requests/4");
});

test("GitLab checkouts explain the unsupported forge before creating a PR", () => {
  expect(
    step({ repository: { ...repository, forge: "gitlab", host: "gitlab.com" } }),
  ).toMatchObject({ kind: "create-pr", blocked: /^GitLab merge requests aren't supported yet/ });
});
