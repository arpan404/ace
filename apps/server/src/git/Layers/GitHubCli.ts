import { Effect, Layer, Schema } from "effect";
import {
  GitHubCliError,
  PositiveInt,
  TrimmedNonEmptyString,
  type GitHubIssue,
  type GitHubIssueThread,
} from "@ace/contracts";

import { runProcess } from "../../processRunner";
import {
  GitHubCli,
  type GitHubRepositoryCloneUrls,
  type GitHubCliShape,
  type GitHubPullRequestSummary,
} from "../Services/GitHubCli.ts";
import { parseJsonFromCliOutputCandidates } from "../githubCliJson.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

function normalizeGitHubCliError(operation: "execute" | "stdout", error: unknown): GitHubCliError {
  if (error instanceof Error) {
    if (error.message.includes("Command not found: gh")) {
      return new GitHubCliError({
        operation,
        detail: "GitHub CLI (`gh`) is required but not available on PATH.",
        cause: error,
      });
    }

    const lower = error.message.toLowerCase();
    if (
      lower.includes("authentication failed") ||
      lower.includes("not logged in") ||
      lower.includes("gh auth login") ||
      lower.includes("no oauth token")
    ) {
      return new GitHubCliError({
        operation,
        detail: "GitHub CLI is not authenticated. Run `gh auth login` and retry.",
        cause: error,
      });
    }

    if (
      lower.includes("could not resolve to a pullrequest") ||
      lower.includes("repository.pullrequest") ||
      lower.includes("no pull requests found for branch") ||
      lower.includes("pull request not found")
    ) {
      return new GitHubCliError({
        operation,
        detail: "Pull request not found. Check the PR number or URL and try again.",
        cause: error,
      });
    }

    if (
      lower.includes("could not resolve to an issue") ||
      lower.includes("repository.issue") ||
      lower.includes("issue not found")
    ) {
      return new GitHubCliError({
        operation,
        detail: "Issue not found. Check the issue number and try again.",
        cause: error,
      });
    }

    if (
      lower.includes("has disabled issues") ||
      lower.includes("issues are disabled") ||
      lower.includes("disabled for this repository")
    ) {
      return new GitHubCliError({
        operation,
        detail:
          "GitHub issues are disabled for this repository. Enable Issues in repository settings or choose another repository.",
        cause: error,
      });
    }

    return new GitHubCliError({
      operation,
      detail: `GitHub CLI command failed: ${error.message}`,
      cause: error,
    });
  }

  return new GitHubCliError({
    operation,
    detail: "GitHub CLI command failed.",
    cause: error,
  });
}

function normalizePullRequestState(input: {
  state?: string | null | undefined;
  mergedAt?: string | null | undefined;
}): "open" | "closed" | "merged" {
  const mergedAt = input.mergedAt;
  const state = input.state;
  if ((typeof mergedAt === "string" && mergedAt.trim().length > 0) || state === "MERGED") {
    return "merged";
  }
  if (state === "CLOSED") {
    return "closed";
  }
  return "open";
}

const RawGitHubPullRequestSchema = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  baseRefName: TrimmedNonEmptyString,
  headRefName: TrimmedNonEmptyString,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  isCrossRepository: Schema.optional(Schema.Boolean),
  headRepository: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nameWithOwner: Schema.String,
      }),
    ),
  ),
  headRepositoryOwner: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        login: Schema.String,
      }),
    ),
  ),
});

const RawGitHubRepositoryCloneUrlsSchema = Schema.Struct({
  nameWithOwner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
});

const RawGitHubIssueSchema = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  url: TrimmedNonEmptyString,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  labels: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: TrimmedNonEmptyString,
      }),
    ),
  ),
  assignees: Schema.optional(
    Schema.Array(
      Schema.Struct({
        login: TrimmedNonEmptyString,
      }),
    ),
  ),
  author: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        login: TrimmedNonEmptyString,
      }),
    ),
  ),
  createdAt: TrimmedNonEmptyString,
  updatedAt: TrimmedNonEmptyString,
});

const RawGitHubIssueCommentSchema = Schema.Struct({
  author: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        login: TrimmedNonEmptyString,
      }),
    ),
  ),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: TrimmedNonEmptyString,
  updatedAt: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  url: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});

const RawGitHubIssueThreadSchema = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  url: TrimmedNonEmptyString,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  labels: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: TrimmedNonEmptyString,
      }),
    ),
  ),
  assignees: Schema.optional(
    Schema.Array(
      Schema.Struct({
        login: TrimmedNonEmptyString,
      }),
    ),
  ),
  author: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        login: TrimmedNonEmptyString,
      }),
    ),
  ),
  createdAt: TrimmedNonEmptyString,
  updatedAt: TrimmedNonEmptyString,
  comments: Schema.optional(Schema.Array(RawGitHubIssueCommentSchema)),
});

function normalizePullRequestSummary(
  raw: Schema.Schema.Type<typeof RawGitHubPullRequestSchema>,
): GitHubPullRequestSummary {
  const headRepositoryNameWithOwner = raw.headRepository?.nameWithOwner ?? null;
  const headRepositoryOwnerLogin =
    raw.headRepositoryOwner?.login ??
    (typeof headRepositoryNameWithOwner === "string" && headRepositoryNameWithOwner.includes("/")
      ? (headRepositoryNameWithOwner.split("/")[0] ?? null)
      : null);
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    state: normalizePullRequestState(raw),
    ...(typeof raw.isCrossRepository === "boolean"
      ? { isCrossRepository: raw.isCrossRepository }
      : {}),
    ...(headRepositoryNameWithOwner ? { headRepositoryNameWithOwner } : {}),
    ...(headRepositoryOwnerLogin ? { headRepositoryOwnerLogin } : {}),
  };
}

function normalizeRepositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawGitHubRepositoryCloneUrlsSchema>,
): GitHubRepositoryCloneUrls {
  return {
    nameWithOwner: raw.nameWithOwner,
    url: raw.url,
    sshUrl: raw.sshUrl,
  };
}

function normalizeIssueState(state: string | null | undefined): "open" | "closed" {
  if (state === "CLOSED" || state === "closed") {
    return "closed";
  }
  return "open";
}

function normalizeGitHubIssue(raw: Schema.Schema.Type<typeof RawGitHubIssueSchema>): GitHubIssue {
  return {
    number: raw.number,
    title: raw.title,
    state: normalizeIssueState(raw.state),
    url: raw.url,
    body: raw.body ?? null,
    labels: (raw.labels ?? []).map((label) => ({ name: label.name })),
    assignees: (raw.assignees ?? []).map((assignee) => ({ login: assignee.login })),
    author: raw.author ? { login: raw.author.login } : null,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

function normalizeGitHubIssueThread(
  raw: Schema.Schema.Type<typeof RawGitHubIssueThreadSchema>,
): GitHubIssueThread {
  return {
    number: raw.number,
    title: raw.title,
    state: normalizeIssueState(raw.state),
    url: raw.url,
    body: raw.body ?? null,
    labels: (raw.labels ?? []).map((label) => ({ name: label.name })),
    assignees: (raw.assignees ?? []).map((assignee) => ({ login: assignee.login })),
    author: raw.author ? { login: raw.author.login } : null,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    comments: (raw.comments ?? []).map((comment) => ({
      author: comment.author ? { login: comment.author.login } : null,
      body: comment.body ?? null,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt ?? null,
      url: comment.url ?? null,
    })),
  };
}

function decodeGitHubJson<S extends Schema.Top>(
  raw: string,
  schema: S,
  operation:
    | "listOpenPullRequests"
    | "listIssues"
    | "getIssueThread"
    | "getPullRequest"
    | "getRepositoryCloneUrls",
  invalidDetail: string,
): Effect.Effect<S["Type"], GitHubCliError, S["DecodingServices"]> {
  return Effect.try({
    try: () => {
      const parsedCandidates = parseJsonFromCliOutputCandidates(raw);
      let lastError: unknown = null;

      for (const candidate of parsedCandidates) {
        try {
          return Schema.decodeUnknownSync(schema)(candidate);
        } catch (error) {
          lastError = error;
        }
      }

      if (lastError instanceof Error) {
        throw lastError;
      }
      throw new Error("No JSON payload matched expected GitHub CLI schema.");
    },
    catch: (error) =>
      new GitHubCliError({
        operation,
        detail: error instanceof Error ? `${invalidDetail}: ${error.message}` : invalidDetail,
        cause: error,
      }),
  }).pipe(Effect.map((value) => value as S["Type"]));
}

const makeGitHubCli = Effect.sync(() => {
  const execute: GitHubCliShape["execute"] = (input) =>
    Effect.tryPromise({
      try: () =>
        runProcess("gh", input.args, {
          cwd: input.cwd,
          timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        }),
      catch: (error) => normalizeGitHubCliError("execute", error),
    });

  const service = {
    execute,
    listOpenPullRequests: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "list",
          "--head",
          input.headSelector,
          "--state",
          "open",
          "--limit",
          String(input.limit ?? 1),
          "--json",
          "number,title,url,baseRefName,headRefName,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : decodeGitHubJson(
                raw,
                Schema.Array(RawGitHubPullRequestSchema),
                "listOpenPullRequests",
                "GitHub CLI returned invalid PR list JSON.",
              ),
        ),
        Effect.map((pullRequests) => pullRequests.map(normalizePullRequestSummary)),
      ),
    listIssues: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "issue",
          "list",
          "--state",
          input.state ?? "open",
          "--limit",
          String(input.limit ?? 30),
          ...(input.labels ?? []).flatMap((label) => ["--label", label]),
          ...(input.query ? ["--search", input.query] : []),
          "--json",
          "number,title,state,url,body,labels,assignees,author,createdAt,updatedAt",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : decodeGitHubJson(
                raw,
                Schema.Array(RawGitHubIssueSchema),
                "listIssues",
                "GitHub CLI returned invalid issue list JSON.",
              ),
        ),
        Effect.map((issues) => issues.map(normalizeGitHubIssue)),
      ),
    getIssueThread: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "issue",
          "view",
          String(input.issueNumber),
          "--json",
          "number,title,state,url,body,labels,assignees,author,createdAt,updatedAt,comments",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeGitHubJson(
            raw,
            RawGitHubIssueThreadSchema,
            "getIssueThread",
            "GitHub CLI returned invalid issue thread JSON.",
          ),
        ),
        Effect.map(normalizeGitHubIssueThread),
      ),
    getPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "view",
          input.reference,
          "--json",
          "number,title,url,baseRefName,headRefName,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeGitHubJson(
            raw,
            RawGitHubPullRequestSchema,
            "getPullRequest",
            "GitHub CLI returned invalid pull request JSON.",
          ),
        ),
        Effect.map(normalizePullRequestSummary),
      ),
    getRepositoryCloneUrls: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "view", input.repository, "--json", "nameWithOwner,url,sshUrl"],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeGitHubJson(
            raw,
            RawGitHubRepositoryCloneUrlsSchema,
            "getRepositoryCloneUrls",
            "GitHub CLI returned invalid repository JSON.",
          ),
        ),
        Effect.map(normalizeRepositoryCloneUrls),
      ),
    createPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "create",
          "--base",
          input.baseBranch,
          "--head",
          input.headSelector,
          "--title",
          input.title,
          "--body-file",
          input.bodyFile,
        ],
      }).pipe(Effect.asVoid),
    getDefaultBranch: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
      }).pipe(
        Effect.map((value) => {
          const trimmed = value.stdout.trim();
          return trimmed.length > 0 ? trimmed : null;
        }),
      ),
    checkoutPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: ["pr", "checkout", input.reference, ...(input.force ? ["--force"] : [])],
      }).pipe(Effect.asVoid),
  } satisfies GitHubCliShape;

  return service;
});

export const GitHubCliLive = Layer.effect(GitHubCli, makeGitHubCli);
