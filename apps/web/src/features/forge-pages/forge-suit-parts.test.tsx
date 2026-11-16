import { pullRequestDetails, seedForgeBrowse, seedLongIssue, workbench } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, expect, test } from "vitest";
import { loadPrDetail } from "@/features/forge/index.ts";
import { harness } from "@/test/harness.tsx";

/*
 * The Suit styling contract (ADR 0150, docs/design/suit-parts.md) on the Code review pages:
 * each test opens one page with the design's fake repository and fails when the page stops
 * naming itself (`data-page`) or stops drawing one of its parts.
 */

// The PR view is its own chunk; load it once so a page's first open doesn't wait on it.
beforeAll(async () => {
  await loadPrDetail();
}, 120_000);

function withRepository() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  const now = Date.now();
  seedForgeBrowse(app.daemon, now);
  seedLongIssue(app.daemon, now);
  return app;
}

/** The `data-variant` of the page named `page` (a PR's or issue's state). */
const pageVariant = (page: string) =>
  document.querySelector(`[data-part="page"][data-page="${page}"]`)?.getAttribute("data-variant");

/** The parts drawn inside the page named `page`, missing from `parts`. */
function missingIn(page: string, parts: readonly string[]): string[] {
  const root = document.querySelector(`[data-part="page"][data-page="${page}"]`);
  if (!root) return [`page[data-page=${page}]`];
  const shown = new Set(
    [...root.querySelectorAll("[data-part]")].map((element) => element.getAttribute("data-part")),
  );
  return parts.filter((part) => !shown.has(part));
}

const listPage = [
  "page-body",
  "page-toolbar",
  "search-field",
  "card",
  "filter-bar",
  "tabs",
  "tab",
  "badge",
  "select",
  "button",
  "list",
] as const;

const pullsPage = [...listPage, "pr-row", "label-chip", "avatar"] as const;

test("the pull requests list names its page, bar, box and rows", async () => {
  const app = withRepository();
  await app.open("/pulls?project=ace");
  await screen.findByRole("navigation", { name: "Pull requests" });
  await waitFor(() => expect(missingIn("pulls", pullsPage)).toEqual([]));
  const draft = document.querySelector('[data-part="pr-row"][data-variant="draft"]');
  expect(draft?.textContent).toContain("Draft");
});

const issuesPage = [...listPage, "issue-row", "label-chip", "avatar"] as const;

test("the issues list names its page, bar, box and rows", async () => {
  const app = withRepository();
  await app.open("/issues?project=ace");
  await screen.findByRole("navigation", { name: "Issues" });
  await waitFor(() => expect(missingIn("issues", issuesPage)).toEqual([]));
});

const inboxPage = [
  "page-body",
  "page-toolbar",
  "page-section",
  "search-field",
  "card",
  "filter-bar",
  "list",
  "list-row",
  "nav-item",
  "checkbox",
] as const;

test("the inbox names its filter column and its notifications, unread ones as unread", async () => {
  const app = withRepository();
  await app.open("/inbox");
  await screen.findByRole("navigation", { name: "Notifications" });
  await waitFor(() => expect(missingIn("inbox", inboxPage)).toEqual([]));
  expect(document.querySelectorAll('[data-part="list-row"][data-state="unread"]')).toHaveLength(7);
  expect(
    document.querySelector('[data-part="nav-item"][data-state="active"]')?.textContent,
  ).toMatch(/^Inbox/);
});

const issuePage = [
  "page-header",
  "page-title",
  "page-toolbar",
  "page-body",
  "page-section",
  "badge",
  "list",
  "timeline-item",
  "avatar",
] as const;

test("an issue's page names its header, sections and timeline", async () => {
  const app = withRepository();
  await app.open("/issues/ace/260");
  const page = await screen.findByRole("article", { name: "Issue #260" });
  await within(page).findByText(/Newest: the fix in #229 looks right/);
  await waitFor(() => expect(missingIn("issue", issuePage)).toEqual([]));
  expect(pageVariant("issue")).toBe("open");
});

const pullSummary = [
  "page-header",
  "page-title",
  "page-toolbar",
  "page-body",
  "page-section",
  "pr-header",
  "branch-chip",
  "badge",
  "card",
  "merge-box",
  "list-row",
  "label-chip",
  "avatar",
] as const;

const pullTimeline = ["timeline-item", "review-comment", "review-thread", "diff-file"] as const;

const pullChecks = ["check-row", "list", "list-group"] as const;

test("a pull request's page names its header, merge box and checks", async () => {
  const app = withRepository();
  await app.open("/pulls/ace/229");
  const page = await screen.findByRole("article", { name: "Pull request #229" });
  await within(page).findByRole("region", { name: "Merge status" });
  await waitFor(() => expect(missingIn("pull", pullSummary)).toEqual([]));
  expect(pageVariant("pull")).toBe("open");

  await userEvent.click(within(page).getByRole("tab", { name: /^Checks/ }));
  await waitFor(() => expect(missingIn("pull", pullChecks)).toEqual([]));
  expect(document.querySelector('[data-part="check-row"][data-variant="failed"]')).not.toBeNull();
});

/** acme/docs-site #31 and the other catalog pull requests: reviews and inline conversations. */
const docsSite = "github.com/acme/docs-site";
function withCatalog() {
  const app = withRepository();
  app.daemon.workspace.seedPullRequests(pullRequestDetails(Date.now()));
  return app;
}

test("a pull request's timeline names its reviews and conversations on code", async () => {
  const app = withCatalog();
  await app.open(`/pulls/api/31?repo=${docsSite}&tab=timeline`);
  await screen.findByRole("article", { name: "Pull request #31" });
  await waitFor(() => expect(missingIn("pull", pullTimeline)).toEqual([]));
});

test("a pull request's Code tab is the review page, its conversations on the lines", async () => {
  const app = withCatalog();
  await app.open(`/pulls/api/31?repo=${docsSite}&tab=code`);
  await screen.findByRole("article", { name: "Pull request #31" });
  await waitFor(() =>
    expect(missingIn("review", ["pr-header", "page-body", "review-thread"])).toEqual([]),
  );
});

test("a new pull request's page names its commits", async () => {
  const app = withCatalog();
  await app.open("/pulls/api/new?head=feature/release-notes");
  await screen.findByRole("article", { name: "New pull request" });
  expect(pageVariant("pull")).toBe("new");
  await waitFor(() =>
    expect(missingIn("pull", ["page-body", "page-section", "list", "commit-row"])).toEqual([]),
  );
});
