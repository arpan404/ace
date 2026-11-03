import { expect, test } from "vitest";
import {
  ForgeIssueSearch,
  type ForgeIssueDetail,
  type ForgeIssueList,
  type ForgeIssueRow,
} from "@ace/protocol";
import { freshenIssueList } from "./issue-freshen.ts";

const repository = { forge: "github", host: "github.com", owner: "acme", name: "ace" } as const;
const row = (number: number, updatedAt: string, patch: Partial<ForgeIssueRow> = {}) => ({
  ref: { repository, number },
  title: `Issue ${number}`,
  url: `https://github.com/acme/ace/issues/${number}`,
  author: "mira",
  state: "open" as const,
  labels: [],
  assignees: [],
  milestone: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt,
  ...patch,
});
const detail = (base: ForgeIssueRow, patch: Partial<ForgeIssueDetail>): ForgeIssueDetail => ({
  ...base,
  body: "",
  permissions: { edit: true, close: true, reopen: true, comment: true, reason: "" },
  relatedThreads: [],
  relatedThreadsTruncated: false,
  ...patch,
});
const list = (items: ForgeIssueRow[]): ForgeIssueList => ({
  repository,
  items,
  total: items.length,
  counts: { open: items.length, closed: 4 },
  canCreate: true,
  unavailableReason: "",
  incomplete: false,
  truncated: false,
});
const open = ForgeIssueSearch.parse({});
const issues = [row(3, "2026-10-03T00:00:00Z"), row(2, "2026-10-02T00:00:00Z")];

test("an issue closed since search last indexed it leaves the open list, and the counts follow", () => {
  const closed = detail(issues[1]!, { state: "closed", updatedAt: "2026-10-04T00:00:00Z" });
  const fresh = freshenIssueList(list(issues), open, 1, [closed]);
  expect(fresh.items.map((item) => item.ref.number)).toEqual([3]);
  expect(fresh.counts).toEqual({ open: 1, closed: 5 });
});

test("a label added since search last indexed it shows on the row", () => {
  const labelled = detail(issues[0]!, { labels: ["bug"], updatedAt: "2026-10-04T00:00:00Z" });
  const fresh = freshenIssueList(list(issues), open, 1, [labelled]);
  expect(fresh.items[0]?.labels).toEqual(["bug"]);
});

test("a row search answered after the issue was read keeps search's newer word", () => {
  const older = detail(row(3, "2026-10-01T00:00:00Z"), { state: "closed" });
  expect(freshenIssueList(list(issues), open, 1, [older]).items).toHaveLength(2);
});

test("an issue reopened since search last indexed it joins the open list by its update time", () => {
  const reopened = detail(row(9, "2026-10-02T12:00:00Z"), {});
  const fresh = freshenIssueList(list(issues), open, 1, [reopened]);
  expect(fresh.items.map((item) => item.ref.number)).toEqual([3, 9, 2]);
  // Not into a list whose search words it can't be checked against.
  const searched = ForgeIssueSearch.parse({ search: "retry" });
  expect(freshenIssueList(list(issues), searched, 1, [reopened]).items).toHaveLength(2);
});
