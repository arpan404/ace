import {
  ForgeIssueDetail,
  ForgePrDetail,
  type ForgeActivity,
  type ForgeBrowserResult,
  type ForgeRepository,
} from "@ace/protocol";
import {
  check,
  file,
  lifecycle,
  mergeState,
  review,
  type PullRequestFixture,
} from "./pull-request-details.ts";

/*
 * The Pull requests view's lists for the design's main repository: pull requests in every state
 * (yours, ones waiting on your review, failing, draft, merged, closed) and issues, open and
 * closed, assigned and not. The account `gh` is signed in as is "you".
 */

const minute = 60_000;
const hour = 60 * minute;
const iso = (at: number) => new Date(Math.max(0, at)).toISOString();
const repository: ForgeRepository = {
  forge: "github",
  host: "github.com",
  owner: "acme",
  name: "ace",
};

interface PrSketch {
  number: number;
  title: string;
  state: "open" | "draft" | "merged" | "closed";
  author: string;
  reviewers: string[];
  ci: "success" | "failure" | "pending" | "none";
  updated: number;
  body: string;
  labels?: string[];
  files: [string, number, number][];
}

function sketched(now: number, pr: PrSketch): PullRequestFixture {
  const headSha = pr.number.toString(16).padStart(40, "e");
  const at = now - pr.updated;
  const checks =
    pr.ci === "none"
      ? []
      : [
          check("lint", "success", at - 6 * minute),
          check("typecheck", pr.ci === "pending" ? "pending" : "success", at - 5 * minute),
          check("test (web)", pr.ci, at - 4 * minute),
        ];
  const detail = ForgePrDetail.parse({
    status: {
      ref: { repository, number: pr.number },
      title: pr.title,
      url: `https://github.com/acme/ace/pull/${pr.number}`,
      headSha,
      state: pr.state === "draft" ? "draft" : pr.state,
      mergeability: pr.state === "open" ? "mergeable" : "unknown",
      ci: pr.ci,
      checks,
      comments: [],
      reviewThreads: [],
      raw: {},
    },
    body: pr.body,
    author: pr.author,
    createdAt: iso(at - 26 * hour),
    updatedAt: iso(at),
    additions: pr.files.reduce((sum, [, add]) => sum + add, 0),
    deletions: pr.files.reduce((sum, [, , del]) => sum + del, 0),
    headBranch: `work/${pr.number}`,
    baseBranch: "main",
    baseSha: pr.number.toString(16).padStart(40, "f"),
    headRepository: repository,
    labels: pr.labels ?? [],
    reviewers: pr.reviewers,
    reviewDecision: pr.state === "open" ? "REVIEW_REQUIRED" : null,
    commits: pr.files.length,
    changedFiles: pr.files.length,
    relatedThreads: [],
    relatedThreadsTruncated: false,
  });
  const open = pr.state === "open" || pr.state === "draft";
  const activity: ForgeActivity[] = [];
  return {
    detail,
    ...(open
      ? {
          mergeState: mergeState(headSha, {
            mergeState: pr.ci === "failure" ? "UNSTABLE" : "BLOCKED",
            reviewDecision: "REVIEW_REQUIRED",
            checksState: pr.ci === "failure" ? "FAILURE" : "SUCCESS",
          }),
        }
      : {}),
    lifecycle: lifecycle(detail, open ? ["close"] : []),
    review: review(headSha, open),
    files: pr.files.map(([path, add, del]) => file(path, add, del)),
    activity,
  };
}

export function browsePullRequests(now: number): PullRequestFixture[] {
  const sketches: PrSketch[] = [
    {
      number: 231,
      title: "Pull requests and issues page",
      state: "open",
      author: "you",
      reviewers: ["mira"],
      ci: "pending",
      updated: 12 * minute,
      labels: ["web"],
      body: "Adds a Pull requests view beside Automations and Skills: a project's PRs and issues in the sidebar, each opened as a page.",
      files: [
        ["apps/web/src/features/forge-pages/forge-sidebar.tsx", 180, 0],
        ["apps/web/src/features/forge-pages/issue-page.tsx", 160, 0],
      ],
    },
    {
      number: 229,
      title: "Reconnect the client worker after sleep",
      state: "open",
      author: "sam",
      reviewers: ["you"],
      ci: "failure",
      updated: 2 * hour,
      labels: ["bug", "client"],
      body: "The worker kept a dead socket after the Mac slept. It now pings on visibility change and reconnects.",
      files: [
        ["packages/client-worker/src/socket.ts", 42, 9],
        ["packages/client-worker/src/socket.test.ts", 61, 0],
      ],
    },
    {
      number: 227,
      title: "Sketch the iOS share extension",
      state: "draft",
      author: "you",
      reviewers: [],
      ci: "none",
      updated: 26 * hour,
      body: "Early sketch, not ready for review.",
      files: [["native/ios/Share/ShareViewController.swift", 120, 0]],
    },
    {
      number: 224,
      title: "Retry provider logins once on a 502",
      state: "open",
      author: "mira",
      reviewers: ["you", "sam"],
      ci: "success",
      updated: 3 * 24 * hour,
      labels: ["providers"],
      body: "A login probe that hits a 502 is retried once before the provider shows as signed out.",
      files: [["apps/daemon/src/provider-login.ts", 18, 4]],
    },
    {
      number: 219,
      title: "Move history import to a worker",
      state: "closed",
      author: "dana",
      reviewers: ["you"],
      ci: "success",
      updated: 6 * 24 * hour,
      body: "Superseded by the streaming importer.",
      files: [["packages/history-import/src/worker.ts", 88, 12]],
    },
  ];
  return sketches.map((pr) => sketched(now, pr));
}

function issue(
  now: number,
  number: number,
  title: string,
  patch: { state?: "open" | "closed"; author: string; assignees?: string[]; labels?: string[] },
  updated: number,
  body: string,
): ForgeIssueDetail {
  return ForgeIssueDetail.parse({
    ref: { repository, number },
    title,
    url: `https://github.com/acme/ace/issues/${number}`,
    author: patch.author,
    state: patch.state ?? "open",
    labels: patch.labels ?? [],
    assignees: patch.assignees ?? [],
    milestone: null,
    createdAt: iso(now - updated - 30 * hour),
    updatedAt: iso(now - updated),
    body,
    permissions: { edit: true, close: true, reopen: true, comment: true, reason: "" },
    relatedThreads: [],
    relatedThreadsTruncated: false,
  });
}

/** Issue details and timelines, keyed as the daemon's reads are, for `setForgeRead`. */
export function browseIssues(now: number): { number: number; reads: ForgeBrowserResult[] }[] {
  const issues = [
    issue(
      now,
      240,
      "Sidebar loses its scroll position after archiving",
      { author: "mira", labels: ["bug", "web"], assignees: ["you"] },
      40 * minute,
      "Archive a thread far down the list: the list jumps back to the top.\n\n1. Scroll to the bottom\n2. Archive a thread\n3. The list is back at the top",
    ),
    issue(
      now,
      238,
      "Show the merge queue position on the work card",
      { author: "sam", labels: ["enhancement"] },
      5 * hour,
      "When a PR is queued, the work card could say where it sits in the queue.",
    ),
    issue(
      now,
      235,
      "Codex threads stay Working after the CLI exits",
      { author: "you", labels: ["bug", "providers"], assignees: ["dana"] },
      2 * 24 * hour,
      "Seen twice after `codex` crashed mid-turn. The thread never settles.",
    ),
    issue(
      now,
      230,
      "Document the fake daemon's fixture worlds",
      { author: "dana", state: "closed", labels: ["docs"] },
      4 * 24 * hour,
      "Each `?fakeWorld=` should be listed with what it shows.",
    ),
  ];
  return issues.map((detail) => ({
    number: detail.ref.number,
    reads: [
      { resource: "issueDetail", value: detail },
      {
        resource: "issueTimeline",
        events:
          detail.ref.number === 240
            ? [
                {
                  id: "c-240-1",
                  kind: "issue_comment",
                  event: "commented",
                  actor: "sam",
                  at: iso(now - 50 * minute),
                  body: "Reproduced on the desktop app too. It only happens with more than one page of threads.",
                  raw: {},
                },
                {
                  id: "e-240-2",
                  kind: "activity",
                  event: "labeled",
                  actor: "mira",
                  at: iso(now - 45 * minute),
                  raw: { label: { name: "web" } },
                },
                {
                  id: "e-240-3",
                  kind: "activity",
                  event: "assigned",
                  actor: "mira",
                  at: iso(now - 40 * minute),
                  raw: { assignee: { login: "you" } },
                },
              ]
            : [],
        truncated: false,
      },
    ],
  }));
}
