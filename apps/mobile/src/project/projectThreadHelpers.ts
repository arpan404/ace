import {
  DEFAULT_MODEL_BY_PROVIDER,
  type GitHubIssueThread,
  type ModelSelection,
  type ProjectScript,
  type ProviderKind,
  type ServerProvider,
} from "@ace/contracts";

const MAX_SCRIPT_ID_LENGTH = 48;
const GITHUB_ISSUE_CONTEXT_CLOSE_TAG = "</github_issue_context>";
const GITHUB_ISSUE_CONTEXT_SANITIZED_CLOSE_TAG = "</ github_issue_context>";
const MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*\]\(([^)\s]+)\)/gu;
const HTML_IMAGE_PATTERN = /<img[^>]+src=["']([^"'>\s]+)["']/giu;
const ALLOWED_GITHUB_IMAGE_HOST_SUFFIXES = [
  "github.com",
  "githubusercontent.com",
  "githubassets.com",
];

export function makeThreadTitle(prompt: string, firstImageName?: string | null): string {
  const normalized = prompt.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) {
    if (firstImageName) {
      return `Image: ${firstImageName}`;
    }
    return "New agent thread";
  }
  return normalized.length > 60 ? `${normalized.slice(0, 57)}...` : normalized;
}

export function normalizeScriptId(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = cleaned.length > 0 ? cleaned : "script";
  return base.length <= MAX_SCRIPT_ID_LENGTH ? base : base.slice(0, MAX_SCRIPT_ID_LENGTH);
}

export function nextProjectScriptId(name: string, scripts: ReadonlyArray<ProjectScript>): string {
  const taken = new Set(scripts.map((script) => script.id));
  const baseId = normalizeScriptId(name);
  if (!taken.has(baseId)) {
    return baseId;
  }

  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${baseId}-${suffix}`;
    const safeCandidate =
      candidate.length <= MAX_SCRIPT_ID_LENGTH
        ? candidate
        : `${baseId.slice(0, Math.max(1, MAX_SCRIPT_ID_LENGTH - String(suffix).length - 1))}-${suffix}`;
    if (!taken.has(safeCandidate)) {
      return safeCandidate;
    }
  }

  return `${baseId}-${Date.now()}`.slice(0, MAX_SCRIPT_ID_LENGTH);
}

function normalizeIssueText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replaceAll(GITHUB_ISSUE_CONTEXT_CLOSE_TAG, GITHUB_ISSUE_CONTEXT_SANITIZED_CLOSE_TAG);
}

function isAllowedGitHubImageUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return ALLOWED_GITHUB_IMAGE_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

function resolveGitHubIssueImageHref(href: string, issueUrl: string): string | null {
  const trimmed = href.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    if (trimmed.startsWith("//")) {
      const url = new URL(`https:${trimmed}`);
      return isAllowedGitHubImageUrl(url) ? url.toString() : null;
    }
    if (/^https?:\/\//iu.test(trimmed)) {
      const url = new URL(trimmed);
      return isAllowedGitHubImageUrl(url) ? url.toString() : null;
    }

    const base = new URL(issueUrl);
    const url = new URL(trimmed, `${base.origin}/`);
    return isAllowedGitHubImageUrl(url) ? url.toString() : null;
  } catch {
    return null;
  }
}

export function collectIssueImageReferences(issue: GitHubIssueThread): string[] {
  const chunks = [issue.body ?? "", ...issue.comments.map((comment) => comment.body ?? "")];
  const text = chunks.join("\n\n");
  const seen = new Set<string>();
  const urls: string[] = [];

  const push = (href: string) => {
    const resolved = resolveGitHubIssueImageHref(href, issue.url);
    if (!resolved || seen.has(resolved)) {
      return;
    }
    seen.add(resolved);
    urls.push(resolved);
  };

  for (const match of text.matchAll(MARKDOWN_IMAGE_PATTERN)) {
    const href = match[1];
    if (href) {
      push(href);
    }
  }

  HTML_IMAGE_PATTERN.lastIndex = 0;
  let htmlMatch: RegExpExecArray | null;
  while ((htmlMatch = HTML_IMAGE_PATTERN.exec(text)) !== null) {
    const href = htmlMatch[1];
    if (href) {
      push(href);
    }
  }

  return urls;
}

export function buildIssuePrompt(issue: GitHubIssueThread): string {
  const labels = issue.labels.map((label) => normalizeIssueText(label.name).trim()).filter(Boolean);
  const assignees = issue.assignees
    .map((assignee) => normalizeIssueText(assignee.login).trim())
    .filter(Boolean);
  const body = normalizeIssueText(issue.body ?? "").trim();
  const comments = issue.comments
    .map((comment, index) => {
      const author = comment.author?.login
        ? normalizeIssueText(comment.author.login).trim()
        : "unknown";
      const text = normalizeIssueText(comment.body ?? "").trim() || "(empty)";
      return [
        `  - index: ${index + 1}`,
        `    author: ${author}`,
        `    created_at: ${comment.createdAt}`,
        "    body:",
        ...text.split("\n").map((line) => `      ${line}`),
      ].join("\n");
    })
    .join("\n");
  const imageReferences = collectIssueImageReferences(issue);

  return [
    `Solve #${issue.number}: ${normalizeIssueText(issue.title).trim() || "Untitled issue"}`,
    "",
    "<github_issue_context>",
    `number: ${issue.number}`,
    `title: ${normalizeIssueText(issue.title).trim() || "Untitled issue"}`,
    `state: ${issue.state}`,
    `url: ${normalizeIssueText(issue.url).trim()}`,
    `author: ${issue.author?.login ? normalizeIssueText(issue.author.login).trim() : "unknown"}`,
    `labels: ${labels.length > 0 ? labels.join(", ") : "none"}`,
    `assignees: ${assignees.length > 0 ? assignees.join(", ") : "none"}`,
    `created_at: ${issue.createdAt}`,
    `updated_at: ${issue.updatedAt}`,
    "body:",
    ...(body.length > 0
      ? body.split("\n").map((line) => `  ${line}`)
      : ["  (No description provided.)"]),
    comments.length > 0 ? `comment_count: ${issue.comments.length}` : "comments: none",
    ...(comments.length > 0 ? ["comments:", comments] : []),
    imageReferences.length > 0
      ? `image_reference_count: ${imageReferences.length}`
      : "image_references: none",
    ...(imageReferences.length > 0
      ? ["image_references:", ...imageReferences.map((url) => `  - ${normalizeIssueText(url)}`)]
      : []),
    "commit_expectations:",
    "  - Use Conventional Commits when committing changes.",
    `  - Reference #${issue.number} in the commit subject or body.`,
    "  - Stage only files intentionally changed.",
    "</github_issue_context>",
  ].join("\n");
}

export function buildIssueSelectionPrompt(issues: ReadonlyArray<GitHubIssueThread>): string {
  if (issues.length === 1 && issues[0]) {
    return buildIssuePrompt(issues[0]);
  }

  const issueList = issues
    .map(
      (issue) => `#${issue.number}: ${normalizeIssueText(issue.title).trim() || "Untitled issue"}`,
    )
    .join(", ");
  const contexts = issues.map((issue) => buildIssuePrompt(issue)).join("\n\n---\n\n");

  return [
    `Solve ${issues.length} GitHub issues: ${issueList}`,
    "",
    "Use the context below to plan and implement one coherent change set that addresses every listed issue.",
    "",
    contexts,
  ].join("\n");
}

export function buildIssueSelectionThreadTitle(issues: ReadonlyArray<GitHubIssueThread>): string {
  if (issues.length === 1 && issues[0]) {
    return `Solve #${issues[0].number}: ${issues[0].title}`;
  }

  const issueNumbers = issues.map((issue) => `#${issue.number}`).join(", ");
  return `Solve ${issues.length} GitHub issues: ${issueNumbers}`;
}

export function resolveModelSelection(
  provider: ProviderKind,
  availableProviders: ReadonlyArray<ServerProvider>,
  selectedModel?: string | null,
): ModelSelection {
  const providerConfig = availableProviders.find((entry) => entry.provider === provider);
  const defaultModel = DEFAULT_MODEL_BY_PROVIDER[provider];
  const model =
    providerConfig?.models.find((candidate) => candidate.slug === selectedModel)?.slug ??
    providerConfig?.models.find((candidate) => candidate.slug === defaultModel)?.slug ??
    providerConfig?.models[0]?.slug ??
    defaultModel;

  return {
    provider,
    model,
  } as ModelSelection;
}
