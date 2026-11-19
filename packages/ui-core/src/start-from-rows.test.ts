import { ForgeIssueRow, ForgePrRow } from "@ace/protocol";
import { expect, test } from "vitest";
import { issueRows, pullRequestRows } from "./start-from-rows.ts";

const repository = { forge: "github", host: "github.com", owner: "acme", name: "ace" } as const;
const pr = (number: number, patch: Partial<ForgePrRow> = {}): ForgePrRow =>
  ForgePrRow.parse({
    ref: { repository, number },
    title: `PR ${number}`,
    url: `https://github.com/acme/ace/pull/${number}`,
    author: "dev",
    state: "open",
    labels: [],
    updatedAt: "2026-11-01T00:00:00Z",
    ci: "success",
    ...patch,
  });

test("open pull requests with failing checks lead, each listed once, with what needs the person", () => {
  const rows = pullRequestRows(
    [pr(1), pr(2, { ci: "failure" }), pr(3, { state: "draft" }), pr(4, { ci: "pending" })],
    // GitHub found #9 by its failed checks: older than the page, it still leads.
    [pr(9, { ci: "failure" }), pr(2, { ci: "failure" })],
  );
  expect(rows.map((row) => [row.number, row.note?.text ?? null])).toEqual([
    [9, "Checks failing"],
    [2, "Checks failing"],
    [1, null],
    [3, "Draft"],
    [4, "Checks running"],
  ]);
  expect(rows[0]?.note?.failed).toBe(true);
});

test("open issues keep the daemon's order and show their first label", () => {
  const issue = ForgeIssueRow.parse({
    ref: { repository, number: 240 },
    title: "Crash on start",
    url: "https://github.com/acme/ace/issues/240",
    author: "dev",
    state: "open",
    labels: ["bug", "ios"],
    assignees: [],
    milestone: "",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
  });
  expect(issueRows([issue])).toEqual([
    {
      url: issue.url,
      number: 240,
      title: "Crash on start",
      note: { text: "bug", failed: false },
      updatedAt: Date.parse("2026-11-01T00:00:00Z"),
    },
  ]);
});
