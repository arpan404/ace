import type { GitHubIssue, GitHubIssueComment, GitHubIssueThread } from "@ace/contracts";

const GITHUB_ISSUE_CONTEXT_BLOCK_CLOSE_TAG = "</github_issue_context>";
const GITHUB_ISSUE_CONTEXT_BLOCK_SANITIZED_CLOSE_TAG = "</ github_issue_context>";

function normalizeIssueText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replaceAll(
      GITHUB_ISSUE_CONTEXT_BLOCK_CLOSE_TAG,
      GITHUB_ISSUE_CONTEXT_BLOCK_SANITIZED_CLOSE_TAG,
    );
}

function normalizeIssueTitle(title: string): string {
  const normalizedTitle = normalizeIssueText(title).trim();
  return normalizedTitle.length > 0 ? normalizedTitle : "Untitled issue";
}

function formatIndentedBlock(text: string, indent: string): string[] {
  const normalized = normalizeIssueText(text).trim();
  if (normalized.length === 0) {
    return [`${indent}(empty)`];
  }
  return normalized.split("\n").map((line) => `${indent}${line}`);
}

function formatCommentSection(comments: ReadonlyArray<GitHubIssueComment>): string[] {
  if (comments.length === 0) {
    return ["comments: none"];
  }
  const lines: string[] = [`comment_count: ${comments.length}`, "comments:"];
  for (let index = 0; index < comments.length; index += 1) {
    const comment = comments[index]!;
    const authorLogin = comment.author ? normalizeIssueText(comment.author.login).trim() : "";
    lines.push(`  - index: ${index + 1}`);
    lines.push(`    author: ${authorLogin.length > 0 ? authorLogin : "unknown"}`);
    lines.push(`    created_at: ${comment.createdAt}`);
    if (comment.updatedAt) {
      lines.push(`    updated_at: ${comment.updatedAt}`);
    }
    if (comment.url) {
      lines.push(`    url: ${normalizeIssueText(comment.url).trim()}`);
    }
    lines.push("    body:");
    lines.push(...formatIndentedBlock(comment.body ?? "", "      "));
  }
  return lines;
}

function commitExpectationLines(issueNumber: number): string[] {
  return [
    "commit_expectations:",
    "  - Use Conventional Commits (for example: fix(scope): short summary).",
    `  - Reference this issue in the commit subject or body (for example: #${issueNumber} or 'Fixes #${issueNumber}').`,
    "  - Create commit(s) for your code changes before you finish the task.",
    "  - When multiple issues are provided, reference all of them across your commit message subject/body.",
    "  - Stage only files you intentionally changed; keep commits focused and reviewable.",
    "  - Do not push, open a pull request, or merge unless the user explicitly asks.",
  ];
}

export function buildGitHubIssueSummaryLabel(issue: Pick<GitHubIssue, "number" | "title">): string {
  return `Tag #${issue.number}: ${normalizeIssueTitle(issue.title)}`;
}

export function buildGitHubIssueContextBlock(issue: GitHubIssue): string {
  return buildGitHubIssueThreadContextBlock({ ...issue, comments: [] });
}

export function buildGitHubIssueThreadContextBlock(thread: GitHubIssueThread): string {
  const labels = thread.labels
    .map((label) => normalizeIssueText(label.name).trim())
    .filter((label) => label.length > 0);
  const assignees = thread.assignees
    .map((assignee) => normalizeIssueText(assignee.login).trim())
    .filter((assignee) => assignee.length > 0);
  const authorLogin = thread.author ? normalizeIssueText(thread.author.login).trim() : "";
  const normalizedBody = normalizeIssueText(thread.body ?? "").trim();

  return [
    "<github_issue_context>",
    `number: ${thread.number}`,
    `title: ${normalizeIssueTitle(thread.title)}`,
    `state: ${thread.state}`,
    `url: ${normalizeIssueText(thread.url).trim()}`,
    `author: ${authorLogin.length > 0 ? authorLogin : "unknown"}`,
    `labels: ${labels.length > 0 ? labels.join(", ") : "none"}`,
    `assignees: ${assignees.length > 0 ? assignees.join(", ") : "none"}`,
    `created_at: ${thread.createdAt}`,
    `updated_at: ${thread.updatedAt}`,
    "body:",
    ...(normalizedBody.length > 0
      ? normalizedBody.split("\n").map((line) => `  ${line}`)
      : ["  (No description provided.)"]),
    ...formatCommentSection(thread.comments),
    ...commitExpectationLines(thread.number),
    "</github_issue_context>",
  ].join("\n");
}

export function buildGitHubIssuePromptFromThread(thread: GitHubIssueThread): string {
  return `${buildGitHubIssueSummaryLabel(thread)}\n\n${buildGitHubIssueThreadContextBlock(thread)}`;
}

export function buildGitHubIssuePromptFromThreads(
  threads: ReadonlyArray<GitHubIssueThread>,
): string {
  if (threads.length === 0) {
    return "";
  }
  if (threads.length === 1) {
    return buildGitHubIssuePromptFromThread(threads[0]!);
  }
  const summary = threads.map((thread) => buildGitHubIssueSummaryLabel(thread)).join("\n");
  const contexts = threads.map((thread) => buildGitHubIssueThreadContextBlock(thread)).join("\n\n");
  return `${summary}\n\n${contexts}`;
}

export function buildGitHubIssuePrompt(issue: GitHubIssue): string {
  return buildGitHubIssuePromptFromThread({ ...issue, comments: [] });
}
