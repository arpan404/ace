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

test("notifications group by why they arrived, everything unknown last", () => {
  const groups = inboxGroups([
    note("1", "ace", "comment"),
    note("2", "ace", "review_requested"),
    note("3", "ace", "ci_activity"),
    note("4", "ace", "assign"),
    note("5", "ace", "a_reason_github_adds_later"),
  ]);
  expect(groups.map((group) => [group.label, group.rows.map((row) => row.id)])).toEqual([
    ["Review requested", ["2"]],
    ["Mentioned and assigned", ["4"]],
    ["Checks and security", ["3"]],
    ["Other activity", ["1", "5"]],
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
