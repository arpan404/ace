import { expect, test } from "vitest";
import type { ForgeInboxRow } from "@ace/protocol";
import {
  inboxBackoffMs,
  inboxGroups,
  inboxPollMs,
  inboxProjects,
  inboxSettledMs,
  rowsForProjects,
} from "./inbox-model.ts";

const list = { host: "github.com", items: [], pollSeconds: 90, unchanged: false };

test("the inbox polls at GitHub's interval, waits longer after a rate limit or lost connection, and longest after a refusal", () => {
  expect(inboxPollMs(list, undefined)).toBe(90_000);
  expect(inboxPollMs(undefined, undefined)).toBe(60_000);
  expect(inboxPollMs(list, "forge_rate_limit")).toBe(inboxBackoffMs);
  expect(inboxPollMs(list, "forge_offline")).toBe(inboxBackoffMs);
  expect(inboxBackoffMs).toBeGreaterThan(90_000);
  // A refusal is asked again rarely, so a fixed sign-in or remote shows up on its own.
  expect(inboxSettledMs).toBeGreaterThan(inboxBackoffMs);
  for (const code of [
    "forge_notifications_unavailable",
    "forge_forbidden",
    "forge_unsupported",
    "forge_no_remote",
    "git_not_a_repo",
    "workspace_not_found",
  ])
    expect(inboxPollMs(list, code)).toBe(inboxSettledMs);
  // Anything else passes on its own: keep GitHub's interval.
  expect(inboxPollMs(list, "forge_cli")).toBe(90_000);
});

const repo = (name: string) => ({
  forge: "github" as const,
  host: "github.com",
  owner: "acme",
  name,
});
const note = (id: string, name: string, reason: string): ForgeInboxRow => ({
  id,
  repository: repo(name),
  type: "PullRequest",
  title: `Notification ${id}`,
  reason,
  unread: true,
  updatedAt: "2026-11-01T00:00:00Z",
  lastReadAt: null,
});

const at = (id: string, name: string, updatedAt: string): ForgeInboxRow => ({
  ...note(id, name, "mention"),
  updatedAt,
});

const local = (day: number, hour: number) => new Date(2026, 10, day, hour).toISOString();

test("by date, notifications fall under Today, Yesterday, This week, This month and Older", () => {
  const now = new Date(2026, 10, 12, 15, 0).getTime();
  const groups = inboxGroups(
    [
      at("1", "ace", local(12, 9)),
      at("2", "ace", local(12, 0)),
      at("3", "ace", local(11, 23)),
      at("4", "ace", local(7, 12)),
      at("5", "ace", local(1, 12)),
      at("6", "ace", new Date(2026, 8, 1).toISOString()),
    ],
    "date",
    now,
  );
  expect(groups.map((group) => [group.label, group.rows.map((row) => row.id)])).toEqual([
    ["Today", ["1", "2"]],
    ["Yesterday", ["3"]],
    ["This week", ["4"]],
    ["This month", ["5"]],
    ["Older", ["6"]],
  ]);
});

test("by repository, each repository is one band, in the order GitHub sent them", () => {
  const groups = inboxGroups(
    [
      note("1", "docs-site", "mention"),
      note("2", "ace", "assign"),
      note("3", "docs-site", "author"),
    ],
    "repo",
    0,
  );
  expect(groups.map((group) => [group.label, group.rows.map((row) => row.id)])).toEqual([
    ["acme/docs-site", ["1", "3"]],
    ["acme/ace", ["2"]],
  ]);
});

test("every project shows the whole account's notifications; picked projects only their own", () => {
  const projectOf = inboxProjects(
    new Map([
      ["p-ace", repo("ace")],
      ["p-docs", repo("Docs-Site")],
    ]),
  );
  const rows = [
    note("1", "ace", "mention"),
    note("2", "docs-site", "mention"),
    note("3", "elsewhere", "mention"),
  ];
  expect(rowsForProjects(rows, [], projectOf).map((row) => row.id)).toEqual(["1", "2", "3"]);
  expect(rowsForProjects(rows, ["p-docs"], projectOf).map((row) => row.id)).toEqual(["2"]);
  expect(rowsForProjects(rows, ["p-ace", "p-docs"], projectOf).map((row) => row.id)).toEqual([
    "1",
    "2",
  ]);
});
