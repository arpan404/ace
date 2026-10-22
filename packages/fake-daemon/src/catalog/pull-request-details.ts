import {
  ForgeActivity,
  ForgeFile,
  ForgeLifecycleState,
  ForgeMergeState,
  ForgePrDetail,
  ForgeReviewState,
  type ForgeRepository,
} from "@ace/protocol";
import { withManagement } from "./pr-management.ts";

/*
 * The full pull request views the design's PR panel opens, one for each state it has to look
 * right in: ready to merge, failing with changes requested while its agent works, and merged.
 * The fake app seeds them (`FakeWorkspaceWire.seedPullRequests`); tests seed their own reads.
 */

const minute = 60_000;
const iso = (at: number) => new Date(Math.max(0, at)).toISOString();
const repo = (name: string): ForgeRepository => ({
  forge: "github",
  host: "github.com",
  owner: "acme",
  name,
});

export interface PullRequestFixture {
  detail: ForgePrDetail;
  mergeState?: ForgeMergeState | undefined;
  lifecycle: ForgeLifecycleState;
  review: ForgeReviewState;
  files: ForgeFile[];
  activity: ForgeActivity[];
}

const patch = (adds: number, dels: number) =>
  [
    `@@ -1,${dels + 2} +1,${adds + 2} @@`,
    " // unchanged context",
    ...Array.from({ length: dels }, (_, i) => `-old line ${i + 1}`),
    ...Array.from({ length: adds }, (_, i) => `+new line ${i + 1}`),
    " // unchanged context",
  ].join("\n");
export const file = (path: string, additions: number, deletions: number, status = "modified") =>
  ForgeFile.parse({
    path,
    status,
    additions,
    deletions,
    patch: patch(Math.min(additions, 12), Math.min(deletions, 8)),
    truncated: false,
  });
export const check = (
  name: string,
  status: "success" | "failure" | "pending",
  at: number,
  url: string | null = null,
) => ({
  id: name,
  name,
  status,
  conclusion: status === "pending" ? null : status,
  completedAt: status === "pending" ? null : iso(at),
  jobId: null,
  url,
});
export const mergeState = (headSha: string, patchState: Partial<ForgeMergeState>) =>
  ForgeMergeState.parse({
    headSha,
    state: "OPEN",
    mergeState: "CLEAN",
    reviewDecision: "APPROVED",
    checksState: "SUCCESS",
    autoMerge: null,
    queue: null,
    canEnable: false,
    canDisable: false,
    canDequeue: false,
    blockers: [],
    raw: {},
    ...patchState,
  });
export const lifecycle = (detail: ForgePrDetail, actions: string[]) =>
  withManagement(
    ForgeLifecycleState.parse({
      snapshot: {
        pr: detail.status.ref,
        id: `PR_${detail.status.ref.number}`,
        version: detail.status.ref.number.toString(16).padStart(64, "a"),
        headSha: detail.status.headSha,
        baseSha: detail.baseSha,
        state: detail.status.state === "unknown" ? "open" : detail.status.state,
        metadata: {
          title: detail.status.title,
          body: detail.body,
          baseBranch: detail.baseBranch,
          labels: detail.labels,
          assignees: [],
        },
        editableFields: detail.status.state === "merged" ? [] : ["title", "body", "labels"],
        actions,
        unsupported: [],
        headBranch: {
          name: detail.headBranch,
          exists: true,
          sameRepository: true,
          isDefault: false,
          deleteOnMerge: false,
        },
      },
      operations: [],
    }),
  );
export const review = (headSha: string, open: boolean) =>
  ForgeReviewState.parse({
    viewer: "you",
    headSha,
    drafts: [],
    viewed: [],
    canReview: open,
    canComment: true,
    resolvableThreads: [],
    operations: [],
  });

function readyToMerge(now: number): PullRequestFixture {
  const repository = repo("billing-api");
  const headSha = "4a".padEnd(40, "1");
  const detail = ForgePrDetail.parse({
    status: {
      ref: { repository, number: 74 },
      title: "Invoice PDF locale fallback",
      url: "https://github.com/acme/billing-api/pull/74",
      headSha,
      state: "open",
      mergeability: "mergeable",
      ci: "success",
      checks: [
        check("lint", "success", now - 28 * minute),
        check("typecheck", "success", now - 27 * minute),
        check("test (pdf)", "success", now - 26 * minute),
        check("test (locale)", "success", now - 26 * minute),
        check("build", "success", now - 25 * minute),
        check("e2e (invoices)", "success", now - 22 * minute),
      ],
      comments: [
        {
          kind: "review",
          id: 801,
          body: "Fallback reads well, and the de-CH fixture covers the case that bit us.",
          author: "mira",
          file: null,
          line: null,
          createdAt: iso(now - 18 * minute),
          updatedAt: iso(now - 18 * minute),
          replyTo: null,
          reviewState: "APPROVED",
        },
      ],
      reviewThreads: [],
      raw: {},
    },
    body: [
      "Invoices for unsupported locales rendered empty. The renderer now falls back to `en-US`",
      "for text while keeping the customer's currency symbol and number grouping.",
      "",
      "- Adds a locale resolver with an explicit fallback chain",
      "- Keeps currency formatting on the customer's locale",
      "- Covers de-CH, pt-AO and an unknown locale in the PDF tests",
      "",
      "Closes #71.",
    ].join("\n"),
    author: "dana",
    createdAt: iso(now - 3 * 60 * minute),
    updatedAt: iso(now - 18 * minute),
    additions: 214,
    deletions: 37,
    headBranch: "fix/pdf-locale",
    baseBranch: "main",
    baseSha: "4b".padEnd(40, "2"),
    headRepository: repository,
    labels: ["bug", "invoices"],
    reviewers: ["mira", "sam"],
    reviewDecision: "APPROVED",
    commits: 4,
    changedFiles: 6,
    relatedThreads: [
      { id: "thread-pdf-locale", title: "Invoice PDF locale fallback", archived: false },
    ],
    relatedThreadsTruncated: false,
  });
  return {
    detail,
    mergeState: mergeState(headSha, {}),
    lifecycle: lifecycle(detail, ["draft", "close"]),
    review: review(headSha, true),
    files: [
      file("src/invoices/pdf/render-invoice.ts", 88, 21),
      file("src/invoices/locale/resolve-locale.ts", 54, 0, "added"),
      file("src/invoices/pdf/render-invoice.test.ts", 41, 6),
      file("src/invoices/locale/currency.ts", 19, 8),
      file("fixtures/invoices/de-CH.json", 9, 0, "added"),
      file("README.md", 3, 2),
    ],
    activity: [],
  };
}

function failingWithChanges(now: number): PullRequestFixture {
  const repository = repo("docs-site");
  const headSha = "31".padEnd(40, "3");
  const question = {
    kind: "inline" as const,
    id: 311,
    body: "Which port does the daemon default to in docker? This still says 3000.",
    author: "mira",
    file: "docs/install.md",
    line: 12,
    createdAt: iso(now - 31 * minute),
    updatedAt: iso(now - 31 * minute),
    replyTo: null,
  };
  const detail = ForgePrDetail.parse({
    status: {
      ref: { repository, number: 31 },
      title: "Rewrite the install page for the daemon",
      url: "https://github.com/acme/docs-site/pull/31",
      headSha,
      state: "open",
      mergeability: "mergeable",
      ci: "failure",
      checks: [
        check("lint", "success", now - 14 * minute),
        check("spellcheck", "success", now - 14 * minute),
        check(
          "links",
          "failure",
          now - 12 * minute,
          "https://github.com/acme/docs-site/actions/runs/31",
        ),
        check("build", "success", now - 13 * minute),
        check("preview", "success", now - 11 * minute),
        check("a11y", "success", now - 11 * minute),
      ],
      comments: [
        {
          kind: "review",
          id: 312,
          body: "The service section is much clearer. Two things before this lands: the docker port and the dead link to the old CLI page.",
          author: "mira",
          file: null,
          line: null,
          createdAt: iso(now - 30 * minute),
          updatedAt: iso(now - 30 * minute),
          replyTo: null,
          reviewState: "CHANGES_REQUESTED",
        },
        question,
      ],
      reviewThreads: [
        {
          id: "RT_31",
          resolved: false,
          outdated: false,
          file: "docs/install.md",
          line: 12,
          comments: [question],
        },
      ],
      raw: {},
    },
    body: [
      "Rewrites the install page around `ace start` and the service install, so a new machine",
      "goes from nothing to a running daemon in three commands.",
      "",
      "## What changed",
      "",
      "- One path for macOS and Linux, with the service install as the default",
      "- Docker gets its own section with the port and volume it needs",
      "- Troubleshooting covers the stale lock and the port already in use",
      "",
      "## Still to do",
      "",
      "- Check every command on a clean machine",
      "- Link the page from the README",
    ].join("\n"),
    author: "you",
    createdAt: iso(now - 2 * 60 * minute),
    updatedAt: iso(now - 4 * minute),
    additions: 312,
    deletions: 141,
    headBranch: "docs/install-daemon",
    baseBranch: "main",
    baseSha: "32".padEnd(40, "4"),
    headRepository: repository,
    labels: ["docs"],
    reviewers: ["mira", "ola"],
    reviewDecision: "CHANGES_REQUESTED",
    commits: 7,
    changedFiles: 5,
    relatedThreads: [
      {
        id: "thread-install-page",
        title: "Rewrite the install page for the daemon",
        archived: false,
      },
    ],
    relatedThreadsTruncated: false,
  });
  return {
    detail,
    mergeState: mergeState(headSha, {
      mergeState: "BEHIND",
      reviewDecision: "CHANGES_REQUESTED",
      checksState: "FAILURE",
      canEnable: true,
      blockers: ["Changes requested", "A required check failed"],
    }),
    lifecycle: lifecycle(detail, ["draft", "close", "update.merge", "update.rebase"]),
    review: review(headSha, true),
    files: [
      file("docs/install.md", 188, 97),
      file("docs/service.md", 64, 0, "added"),
      file("docs/troubleshooting.md", 41, 12),
      file("docs/docker.md", 16, 30),
      file("sidebar.json", 3, 2),
    ],
    activity: [],
  };
}

function merged(now: number): PullRequestFixture {
  const repository = repo("ace");
  const headSha = "d4".padEnd(40, "5");
  const detail = ForgePrDetail.parse({
    status: {
      ref: { repository, number: 212 },
      title: "Bump Codex app-server to 0.48",
      url: "https://github.com/acme/ace/pull/212",
      headSha,
      state: "merged",
      mergeability: "unknown",
      ci: "success",
      checks: [
        check("check", "success", now - 70 * minute),
        check("test (daemon)", "success", now - 68 * minute),
        check("test (web)", "success", now - 67 * minute),
        check("recorder fixtures", "success", now - 66 * minute),
      ],
      comments: [],
      reviewThreads: [],
      raw: {},
    },
    body: "Bumps the Codex app-server to 0.48, re-records 14 fixtures and updates the adapter for the renamed turn events.",
    author: "you",
    createdAt: iso(now - 5 * 60 * minute),
    updatedAt: iso(now - 41 * minute),
    additions: 1_204,
    deletions: 988,
    headBranch: "chore/codex-048",
    baseBranch: "main",
    baseSha: "d5".padEnd(40, "6"),
    headRepository: repository,
    labels: ["dependencies"],
    reviewers: ["sam"],
    reviewDecision: "APPROVED",
    commits: 3,
    changedFiles: 17,
    relatedThreads: [
      { id: "thread-bump-codex", title: "Bump Codex app-server to 0.48", archived: false },
    ],
    relatedThreadsTruncated: false,
  });
  const event = (id: string, name: string, actor: string, at: number) =>
    ForgeActivity.parse({ id, event: name, actor, at: iso(at), raw: {} });
  return {
    detail,
    lifecycle: lifecycle(detail, ["revert"]),
    review: review(headSha, false),
    files: [
      file("apps/daemon/src/providers/codex/app-server.ts", 212, 180),
      file("apps/daemon/src/providers/codex/events.ts", 96, 71),
      file("tools/recorder/fixtures/codex/turn-basic.jsonl", 340, 322),
      file("tools/recorder/fixtures/codex/turn-tools.jsonl", 298, 301),
      file("package.json", 1, 1),
    ],
    activity: [
      event("ev-1", "merged", "sam", now - 41 * minute),
      event("ev-2", "head_ref_deleted", "sam", now - 40 * minute),
    ],
  };
}

export function pullRequestDetails(now: number): PullRequestFixture[] {
  return [readyToMerge(now), failingWithChanges(now), merged(now)];
}
