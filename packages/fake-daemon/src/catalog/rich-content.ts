import { ForgeIssueDetail, type ForgeBrowserResult } from "@ace/protocol";
import { colors } from "../forge-list-rows.ts";
import { media } from "./forge-media.ts";
import { sketchPullRequests } from "./forge-browse.ts";
import type { PullRequestFixture } from "./pull-request-details.ts";

/*
 * A pull request and an issue of `acme/ace` written the way people write on GitHub (ADR 0096):
 * screenshots as `<img width>` uploads, a markdown image, a light and dark `<picture>`, an
 * uploaded recording inside `<details>`, alerts, task lists, emoji, mentions, footnotes, inline
 * HTML, a comment, a script that must stay text, and an attachment that no longer loads.
 */

const minute = 60_000;
const iso = (at: number) => new Date(Math.max(0, at)).toISOString();

export const richPrBody = [
  "The settings page was one long form. This groups it into sections and keeps each section's",
  "save button in view while you scroll.",
  "",
  `<img width="800" height="450" alt="Before" src="${media.before}"> <img width="800" height="450" alt="After" src="${media.after}">`,
  "",
  "> [!NOTE]",
  "> The old URLs redirect, so bookmarks keep working.",
  "",
  "> [!WARNING]",
  "> Clear the settings cache after deploying.",
  "",
  "### How a save travels",
  "",
  `![Client, daemon, gh and GitHub in a row](${media.diagram})`,
  "",
  "<details>",
  "<summary>Recording of the new page</summary>",
  "",
  media.recording,
  "",
  "</details>",
  "",
  '<p align="center">',
  "  <picture>",
  `    <source media="(prefers-color-scheme: dark)" srcset="${media.logoDark}">`,
  `    <img alt="ace logo" src="${media.logoLight}" width="240">`,
  "  </picture>",
  "</p>",
  "",
  "### Checklist",
  "",
  "- [x] Sections and anchors",
  "- [x] Sticky save :tada:",
  "- [ ] Screen reader pass with @mira",
  "- [ ] Update the docs[^docs]",
  "",
  "Press <kbd>⌘</kbd> <kbd>S</kbd> to save. H<sub>2</sub>O and x<sup>2</sup>, <ins>added</ins> and",
  "<del>removed</del>, Fish &amp; Chips &copy; 2026.",
  "",
  `![coverage](${media.badge}) Follows up #238.`,
  "",
  media.notes,
  "",
  `The first draft's screenshot is gone: ![Old layout](${media.missing})`,
  "",
  "<!-- Reviewers: check dark mode too -->",
  "",
  '<script>alert("never runs")</script>',
  "",
  "[^docs]: The settings guide still shows the old single form.",
].join("\n");

export function richPullRequest(now: number): PullRequestFixture {
  const [fixture] = sketchPullRequests(now, [
    {
      number: 245,
      title: "Group the settings page into sections",
      state: "open",
      author: "you",
      reviewers: ["mira"],
      decision: "REVIEW_REQUIRED",
      ci: "success",
      updated: 12 * minute,
      labels: ["web"],
      branch: "settings-sections",
      body: richPrBody,
      files: [
        ["apps/web/src/features/settings/settings-page.tsx", 120, 64],
        ["apps/web/src/features/settings/section.tsx", 58, 0],
      ],
    },
  ]);
  if (!fixture) throw new Error("No rich pull request");
  fixture.detail.status.comments = [
    {
      kind: "issue",
      id: 2451,
      body: [
        "Looks great :rocket: The grouped version reads much better.",
        "",
        `<img width="320" alt="After, small" src="${media.after}">`,
        "",
        "> [!TIP]",
        "> <kbd>Tab</kbd> now moves between sections.",
      ].join("\n"),
      author: "mira",
      file: null,
      line: null,
      createdAt: iso(now - 30 * minute),
      updatedAt: iso(now - 30 * minute),
      replyTo: null,
    },
    {
      kind: "issue",
      id: 2452,
      body: [
        "Before merging:",
        "",
        "- [ ] Rebase on main",
        "- [x] Fix the lint warning",
        "",
        "<details><summary>Lint output</summary>",
        "",
        "```",
        "settings-page.tsx:12:7  warning  unused import",
        "```",
        "",
        "</details>",
      ].join("\n"),
      author: "you",
      file: null,
      line: null,
      createdAt: iso(now - 20 * minute),
      updatedAt: iso(now - 20 * minute),
      replyTo: null,
    },
  ];
  return fixture;
}

export const richIssueBody = [
  "Saving a section scrolls the page back to the top.",
  "",
  `<p align="center"><img width="560" alt="The page after saving" src="${media.before}"></p>`,
  "",
  "> [!CAUTION]",
  "> Unsaved edits in other sections are lost.",
  "",
  "<table>",
  "  <tr><th>Browser</th><th>Seen</th></tr>",
  "  <tr><td>Safari</td><td>Always</td></tr>",
  "  <tr><td>Chrome</td><td>Sometimes</td></tr>",
  "</table>",
  "",
  "- [ ] Reproduce on the desktop app",
  "- [ ] Find the scroll reset",
  "",
  "cc @acme/web",
].join("\n");

/** Issue 246's detail and timeline, as the daemon reads them. */
export function richIssueReads(now: number): ForgeBrowserResult[] {
  const labels = ["bug", "web"];
  const detail = ForgeIssueDetail.parse({
    ref: {
      repository: { forge: "github", host: "github.com", owner: "acme", name: "ace" },
      number: 246,
    },
    title: "Saving a section scrolls the page back to the top",
    url: "https://github.com/acme/ace/issues/246",
    author: "sam",
    state: "open",
    labels,
    labelColors: colors(labels),
    assignees: ["you"],
    milestone: null,
    createdAt: iso(now - 90 * minute),
    updatedAt: iso(now - 25 * minute),
    body: richIssueBody,
    permissions: { edit: true, close: true, reopen: true, comment: true, reason: "" },
    relatedThreads: [],
    relatedThreadsTruncated: false,
  });
  return [
    { resource: "issueDetail", value: detail },
    {
      resource: "issueTimeline",
      events: [
        {
          id: "c-246-1",
          kind: "issue_comment",
          event: "commented",
          actor: "sam",
          at: iso(now - 25 * minute),
          body: [
            "Recorded it in Safari :eyes:",
            "",
            media.recording,
            "",
            "Happens right after the save toast[^toast].",
            "",
            "[^toast]: The toast mounts a new scroller.",
          ].join("\n"),
          raw: {},
        },
      ],
      truncated: false,
    },
  ];
}
