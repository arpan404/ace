import type { ForgeBrowserResult } from "@ace/protocol";
import { issue, sketchPullRequests, type PrSketch } from "./forge-browse.ts";
import type { PullRequestFixture } from "./pull-request-details.ts";

/*
 * Pull requests and issues of the design's other projects (billing-api, ace-mobile, docs-site),
 * so Code review's lists across every project show rows from several repositories, in every
 * group: a review asked of you, an agent's work, checks running, ready to merge.
 */

const minute = 60_000;
const hour = 60 * minute;

const sketches: PrSketch[] = [
  {
    repo: "billing-api",
    number: 112,
    title: "Retry webhook delivery with backoff",
    state: "open",
    author: "you",
    reviewers: ["mira"],
    decision: "CHANGES_REQUESTED",
    ci: "success",
    updated: 8 * minute,
    branch: "fix/webhook-retry",
    body: "Webhooks that fail now retry with a jittered backoff, up to an hour.",
    files: [
      ["src/webhooks/deliver.ts", 64, 18],
      ["src/webhooks/deliver.test.ts", 24, 2],
    ],
  },
  {
    repo: "billing-api",
    number: 109,
    title: "Pin pdfkit to 0.15.2",
    state: "open",
    author: "dependabot",
    reviewers: [],
    decision: "APPROVED",
    ci: "success",
    updated: 26 * hour,
    branch: "deps/pdfkit",
    body: "Bumps pdfkit from 0.15.1 to 0.15.2.",
    files: [["package.json", 2, 2]],
  },
  {
    repo: "ace-mobile",
    number: 17,
    title: "Keep the composer above the keyboard",
    state: "open",
    author: "lee",
    reviewers: ["you"],
    decision: "REVIEW_REQUIRED",
    ci: "pending",
    updated: 20 * minute,
    branch: "fix/keyboard-inset",
    body: "The composer follows the keyboard's frame instead of a fixed inset.",
    files: [["ios/Composer/ComposerView.swift", 41, 7]],
  },
  {
    repo: "ace-mobile",
    number: 15,
    title: "Haptics on swipe to archive",
    state: "draft",
    author: "you",
    reviewers: [],
    ci: "none",
    updated: 2 * 24 * hour,
    branch: "feature/swipe-haptics",
    body: "A light tap when a swipe crosses the archive threshold.",
    files: [["ios/Threads/SwipeRow.swift", 22, 3]],
  },
  {
    repo: "docs-site",
    number: 51,
    title: "Fix broken links in the CLI reference",
    state: "open",
    author: "you",
    reviewers: ["sam"],
    decision: "REVIEW_REQUIRED",
    ci: "success",
    updated: 6 * hour,
    branch: "docs/cli-links",
    body: "Points every `ace` subcommand link at its new page.",
    files: [["content/cli.md", 14, 14]],
  },
];

export function projectPullRequests(now: number): PullRequestFixture[] {
  return sketchPullRequests(now, sketches);
}

/** Issues of the other projects: each its project (the fake's project id) and its reads. */
export function projectIssues(
  now: number,
): { project: string; number: number; reads: ForgeBrowserResult[] }[] {
  const issues = [
    issue(
      now,
      21,
      "Pull to refresh stalls on a slow network",
      { repo: "ace-mobile", author: "mira", labels: ["bug"], assignees: ["you"] },
      3 * hour,
      "On a throttled connection the spinner never stops, even after the list loads.",
    ),
    issue(
      now,
      19,
      "Dynamic Type clips the thread title",
      { repo: "ace-mobile", author: "you", labels: ["accessibility"] },
      30 * hour,
      "At the largest sizes the title is cut off instead of wrapping.",
    ),
    issue(
      now,
      77,
      "Invoices round tax per line instead of per total",
      { repo: "billing-api", author: "dana", labels: ["bug"], assignees: ["you"] },
      90 * minute,
      "A 3-line invoice can be a cent off from the total GitHub shows.",
    ),
    issue(
      now,
      12,
      "Search the docs from the command palette",
      { repo: "docs-site", author: "lee", labels: ["enhancement"] },
      2 * 24 * hour,
      "⌘K could search the docs as well as pages.",
    ),
  ];
  return issues.map((detail) => ({
    project: detail.ref.repository.name,
    number: detail.ref.number,
    reads: [
      { resource: "issueDetail", value: detail },
      { resource: "issueTimeline", events: [], truncated: false },
    ],
  }));
}
