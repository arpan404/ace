import { expect, test } from "vitest";
import type { ForgeIssueDetail } from "@ace/protocol/forge-issues";
import { issueWriteLanded, planIssueWrite } from "./issue-write-plan.ts";

const issue: ForgeIssueDetail = {
  ref: { repository: { forge: "github", host: "github.com", owner: "o", name: "r" }, number: 7 },
  title: "Handle retries",
  body: "Keep order.",
  url: "https://github.com/o/r/issues/7",
  author: "sam",
  state: "open",
  labels: ["bug"],
  assignees: ["mira"],
  milestone: null,
  milestoneNumber: null,
  createdAt: "2026-10-01T00:00:00Z",
  // Moved on since anyone read it: someone commented a second ago.
  updatedAt: "2026-10-02T00:00:09Z",
  permissions: { edit: true, close: true, reopen: true, comment: true, triage: true, reason: "" },
  relatedThreads: [],
  relatedThreadsTruncated: false,
};
const readAt = "2026-10-02T00:00:00Z";

test("closing a busy issue whose activity moved on since it was read still closes, with its reason", () => {
  expect(
    planIssueWrite(issue, {
      action: "state",
      number: 7,
      expectedUpdatedAt: readAt,
      state: "closed",
      reason: "not_planned",
    }),
  ).toEqual({ kind: "patch", body: { state: "closed", state_reason: "not_planned" } });
});

test("closing an issue someone else already closed is done without another write", () => {
  const closed = { ...issue, state: "closed" as const, stateReason: "completed" as const };
  expect(
    planIssueWrite(closed, {
      action: "state",
      number: 7,
      expectedUpdatedAt: readAt,
      state: "closed",
    }),
  ).toEqual({ kind: "done" });
});

test("a title edit lands over someone else's body edit and leaves their body alone", () => {
  const current = { ...issue, body: "Keep order. Also retry." };
  expect(
    planIssueWrite(current, {
      action: "edit",
      number: 7,
      expectedUpdatedAt: readAt,
      title: "Retry in order",
      body: "Keep order.",
      base: { title: "Handle retries", body: "Keep order." },
    }),
  ).toEqual({ kind: "patch", body: { title: "Retry in order" } });
});

test("a body edit conflicts only when someone else changed the body to something else", () => {
  const current = { ...issue, body: "Someone's new text." };
  expect(
    planIssueWrite(current, {
      action: "edit",
      number: 7,
      expectedUpdatedAt: readAt,
      title: "Handle retries",
      body: "My new text.",
      base: { title: "Handle retries", body: "Keep order." },
    }),
  ).toEqual({ kind: "conflict" });
});

test("labels and assignees change by what was added and removed, never by the whole set", () => {
  const current = { ...issue, labels: ["Bug", "added-meanwhile"] };
  // Only the change is sent, so a label someone adds after this read survives the write.
  expect(
    planIssueWrite(current, { action: "labels", number: 7, add: ["ui", "BUG"], remove: ["bug"] }),
  ).toEqual({ kind: "members", field: "labels", add: ["ui"], remove: ["Bug"] });
  expect(
    planIssueWrite(issue, { action: "assignees", number: 7, add: ["mira"], remove: [] }),
  ).toEqual({ kind: "done" });
});

test("labels are refused without triage access, even when the author may edit the title", () => {
  const author = { ...issue, permissions: { ...issue.permissions, triage: false } };
  expect(planIssueWrite(author, { action: "labels", number: 7, add: ["ui"], remove: [] })).toEqual({
    kind: "forbidden",
  });
});

test("a lost milestone or label write is recognised once GitHub shows it", () => {
  expect(
    issueWriteLanded(
      { ...issue, milestoneNumber: 3 },
      { action: "milestone", number: 7, milestone: 3 },
    ),
  ).toBe(true);
  expect(issueWriteLanded(issue, { action: "labels", number: 7, add: ["ui"], remove: [] })).toBe(
    false,
  );
});

test("a lost title edit that kept someone else's newer body is recognised once the title shows", () => {
  const edit = {
    action: "edit",
    number: 7,
    expectedUpdatedAt: readAt,
    title: "Retry in order",
    body: "Keep order.",
    base: { title: "Handle retries", body: "Keep order." },
  } as const;
  const landed = { ...issue, title: "Retry in order", body: "Someone's newer text." };
  expect(issueWriteLanded(landed, edit)).toBe(true);
  expect(issueWriteLanded({ ...issue, body: "Someone's newer text." }, edit)).toBe(false);
});
