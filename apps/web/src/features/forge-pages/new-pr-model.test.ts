import { expect, test } from "vitest";
import type { ForgeCompare } from "@ace/protocol";
import { compareBlocker, prefill } from "./new-pr-model.ts";

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
