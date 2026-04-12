import { describe, expect, it } from "vitest";

import {
  buildGitHubIssueContextBlock,
  buildGitHubIssuePrompt,
  buildGitHubIssuePromptFromThread,
  buildGitHubIssueSummaryLabel,
} from "./githubIssuePrompt";

describe("githubIssuePrompt", () => {
  const issue = {
    number: 42,
    title: "Fix timeline sizing",
    state: "open" as const,
    url: "https://github.com/acme/repo/issues/42",
    body: "Repro:\n1. Open thread",
    labels: [{ name: "bug" }],
    assignees: [{ login: "octocat" }],
    author: { login: "hubot" },
    createdAt: "2026-04-08T00:00:00.000Z",
    updatedAt: "2026-04-08T00:05:00.000Z",
  };

  it("builds a concise issue summary label", () => {
    expect(buildGitHubIssueSummaryLabel(issue)).toBe("Solve #42: Fix timeline sizing");
  });

  it("builds a normalized hidden github issue context block", () => {
    expect(buildGitHubIssueContextBlock(issue)).toBe(
      [
        "<github_issue_context>",
        "number: 42",
        "title: Fix timeline sizing",
        "state: open",
        "url: https://github.com/acme/repo/issues/42",
        "author: hubot",
        "labels: bug",
        "assignees: octocat",
        "created_at: 2026-04-08T00:00:00.000Z",
        "updated_at: 2026-04-08T00:05:00.000Z",
        "body:",
        "  Repro:",
        "  1. Open thread",
        "comments: none",
        "commit_expectations:",
        "  - Use Conventional Commits (for example: fix(scope): short summary).",
        "  - Reference this issue in the commit subject or body (for example: #42 or 'Fixes #42').",
        "  - Stage only files you intentionally changed; keep commits focused and reviewable.",
        "  - Do not push, open a pull request, or merge unless the user explicitly asks.",
        "</github_issue_context>",
      ].join("\n"),
    );
  });

  it("combines summary text with hidden issue context", () => {
    expect(buildGitHubIssuePrompt(issue)).toContain("Solve #42: Fix timeline sizing\n\n");
    expect(buildGitHubIssuePrompt(issue)).toContain("<github_issue_context>");
    expect(buildGitHubIssuePrompt(issue)).toContain("</github_issue_context>");
  });

  it("includes threaded comments in the hidden context", () => {
    const thread = {
      ...issue,
      comments: [
        {
          author: { login: "alice" },
          body: "Still reproduces on Safari.",
          createdAt: "2026-04-08T00:06:00.000Z",
          updatedAt: null,
          url: "https://github.com/acme/repo/issues/42#issuecomment-1",
        },
      ],
    };
    const prompt = buildGitHubIssuePromptFromThread(thread);
    expect(prompt).toContain("comment_count: 1");
    expect(prompt).toContain("author: alice");
    expect(prompt).toContain("Still reproduces on Safari.");
  });
});
