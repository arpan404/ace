import {
  ForgeActivity,
  ForgeFile,
  ForgeLifecycleState,
  ForgeMergeState,
  ForgePrDetail,
  ForgeReviewState,
  type ForgeRepository,
} from "@ace/protocol";

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
    },
    operations: [],
  });
/** The account `gh` is signed in as in the fake app. */
export const viewer = "you";
/**
 * The review state of a sample PR as the daemon reports it: GitHub refuses approving or
 * requesting changes on your own PR, and you may hide your own comments.
 */
export const review = (
  headSha: string,
  open: boolean,
  facts: {
    detail?: ForgePrDetail;
    drafts?: ForgeReviewState["drafts"];
    hidden?: ForgeReviewState["hidden"];
  } = {},
) => {
  const status = facts.detail?.status;
  const own = [
    ...(status?.comments ?? []),
    ...(status?.reviewThreads ?? []).flatMap((t) => t.comments),
  ]
    .filter((c) => c.author === viewer && c.kind !== "review")
    .map((c) => ({
      source: c.kind === "issue" ? ("issue" as const) : ("inline" as const),
      commentId: c.id,
    }));
  return ForgeReviewState.parse({
    viewer,
    headSha,
    drafts: facts.drafts ?? [],
    viewed: [],
    canReview: open && facts.detail?.author !== viewer,
    canComment: true,
    resolvableThreads: open ? (status?.reviewThreads ?? []).map((t) => t.id) : [],
    operations: [],
    reactions: [],
    hidden: facts.hidden ?? [],
    hideable: [...new Map(own.map((c) => [`${c.source}:${c.commentId}`, c])).values()],
  });
};

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
    review: review(headSha, true, { detail }),
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
  // Every file's sample patch is one hunk: line 1 is context, removed lines are 2-9 on the
  // left, added lines are 2-13 on the right (service.md, a new file, removes none).
  const inline = (
    id: number,
    author: string,
    file: string,
    line: number | null,
    ago: number,
    body: string,
    replyTo: number | null = null,
  ) => ({
    kind: "inline" as const,
    id,
    body,
    author,
    authorAvatarUrl: `https://avatars.githubusercontent.com/${author}`,
    file,
    line,
    createdAt: iso(now - ago * minute),
    updatedAt: iso(now - ago * minute),
    replyTo,
  });
  const issue = (id: number, author: string, ago: number, body: string) => ({
    ...inline(id, author, "", null, ago, body),
    kind: "issue" as const,
    file: null,
  });
  const question = inline(
    311,
    "mira",
    "docs/install.md",
    12,
    31,
    "Which port does the daemon default to in docker? This still says 3000.",
  );
  const answer = inline(
    316,
    "you",
    "docs/install.md",
    12,
    20,
    "8080. Fixing it in the next push.",
    311,
  );
  const range = inline(
    313,
    "ola",
    "docs/service.md",
    6,
    28,
    "These four steps could be one `ace service install` call now.",
  );
  const removed = inline(
    314,
    "mira",
    "docs/install.md",
    4,
    27,
    "Older installs still need this flag. Keep it under a note instead of deleting it?",
  );
  const settled = inline(315, "ola", "docs/troubleshooting.md", 5, 26, "Typo: lockfile.");
  const settledReply = inline(317, "you", "docs/troubleshooting.md", 5, 22, "Fixed.", 315);
  const stale = inline(318, "mira", "docs/docker.md", null, 40, "Port 3000 here too.");
  const thread = (
    id: string,
    comments: ReturnType<typeof inline>[],
    anchor: { side: "LEFT" | "RIGHT"; startLine?: number; resolved?: boolean; outdated?: boolean },
  ) => ({
    id,
    resolved: anchor.resolved ?? false,
    outdated: anchor.outdated ?? false,
    file: comments[0]?.file ?? "",
    line: comments[0]?.line ?? null,
    side: anchor.side,
    startLine: anchor.startLine ?? null,
    comments,
  });
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
        issue(
          320,
          "you",
          90,
          "First pass is up. Ignore the port numbers for now, they're placeholders.",
        ),
        issue(321, "ola", 25, "The preview reads well on a phone too."),
        question,
        answer,
        range,
        removed,
        settled,
        settledReply,
        stale,
      ],
      reviewThreads: [
        thread("RT_31", [question, answer], { side: "RIGHT" }),
        thread("RT_32", [range], { side: "RIGHT", startLine: 3 }),
        thread("RT_33", [removed], { side: "LEFT" }),
        thread("RT_34", [settled, settledReply], { side: "RIGHT", resolved: true }),
        thread("RT_35", [stale], { side: "RIGHT", outdated: true }),
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
    review: review(headSha, true, {
      detail,
      hidden: [{ source: "issue", commentId: 320, reason: "outdated" }],
      drafts: [
        {
          id: "draft-stop",
          body: "Mention `ace stop` here as well, next to the restart step.",
          anchor: { commit: headSha, path: "docs/install.md", line: 7, side: "RIGHT" },
        },
        {
          id: "draft-volume",
          body: "This volume block repeats the service section; link to it instead?",
          anchor: { commit: headSha, path: "docs/docker.md", line: 5, side: "RIGHT", startLine: 3 },
        },
      ],
    }),
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
    review: review(headSha, false, { detail }),
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
