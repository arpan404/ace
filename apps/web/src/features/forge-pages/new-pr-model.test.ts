import { expect, test } from "vitest";
import type { ForgeCompare } from "@ace/protocol";
import {
  branchLabel,
  compareBlocker,
  isFork,
  prefill,
  prPageSearch,
} from "./new-pr-model.ts";

const commit = (message: string) => ({
  sha: "a".repeat(40),
  message,
  author: "octo",
  date: null,
  url: "https://github.com/acme/ace/commit/a",
});
const compare = (messages: string[], aheadBy = messages.length): ForgeCompare => ({
  base: "main",
  head: { owner: "acme", name: "ace", branch: "feature/release-notes" },
  status: aheadBy ? "ahead" : "identical",
  aheadBy,
  behindBy: 0,
  mergeBaseSha: "b".repeat(40),
  headSha: "a".repeat(40),
  commits: messages.map(commit),
  totalCommits: messages.length,
  files: [],
  totalFiles: 0,
  truncated: false,
});

test("one commit titles the pull request and fills its description; several give the branch's name", () => {
  expect(prefill("fix/x", compare(["Fix the tooltip\n\nIt waited too long."]), null)).toEqual({
    title: "Fix the tooltip",
    body: "It waited too long.",
  });
  expect(prefill("feature/release-notes", compare(["One", "Two"]), null)).toEqual({
    title: "Feature/release notes",
    body: "",
  });
});

test("the repository's template is the description even for a single commit", () => {
  expect(prefill("fix/x", compare(["Fix\n\nBody"]), "## Summary").body).toBe("## Summary");
});

test("a pull request needs two different branches and a commit the base lacks", () => {
  expect(compareBlocker("main", "main", undefined)).toBe("Pick two different branches.");
  expect(compareBlocker("main", "fix/x", compare([], 0))).toBe("fix/x and main are the same.");
  expect(compareBlocker("main", "fix/x", compare(["One"]))).toBeUndefined();
});

test("a fork's branch may share its name with the parent's base", () => {
  expect(compareBlocker("main", "main", undefined, false)).toBeUndefined();
  expect(compareBlocker("main", "main", compare(["Fork work"]), false)).toBeUndefined();
});

const repo = (owner: string, name: string) =>
  ({ forge: "github", host: "github.com", owner, name }) as const;
const context = (head: ReturnType<typeof repo>, base: ReturnType<typeof repo>) => ({
  base: { repository: base, defaultBranch: "main", branches: [], truncated: false },
  head: { repository: head, branches: [], truncated: false },
  template: null,
});

test("a PR created from a fork opens at the parent's address, not the project's own repository", () => {
  // The project is me/ace, a fork of acme/ace; the PR was opened on acme/ace as #412.
  expect(prPageSearch(repo("acme", "ace"), "?project=ace")).toEqual({
    repo: "github.com/acme/ace",
    back: "?project=ace",
  });
});

test("a fork sharing its parent's owner is still a fork, and its branches say which repository", () => {
  const fork = repo("acme", "ace-fork");
  const parent = repo("acme", "ace");
  expect(isFork(context(fork, parent))).toBe(true);
  expect(isFork(context(parent, parent))).toBe(false);
  expect(branchLabel(fork, parent, "main")).toBe("acme/ace-fork:main");
  expect(branchLabel(repo("me", "ace"), parent, "main")).toBe("me:main");
  expect(branchLabel(parent, parent, "main")).toBe("main");
});
