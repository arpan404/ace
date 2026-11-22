import { expect, test } from "vitest";
import { parseSpadeActivity, spadeActivityInScope, spadeActivityItems } from "./index.ts";

/** A page of Spade's activity, newest first, as `/activity` answers. */
const page = (entries: Record<string, unknown>[]) => {
  const read = parseSpadeActivity(JSON.stringify({ entries, more: false }));
  if (!read) throw new Error("unreadable");
  return read.entries;
};

const notionCall = (seq: number, fields: Record<string, unknown>) => ({
  id: `${seq}-0`,
  seq,
  at: seq * 1000,
  name: "notion__notion-create-pages",
  reply: "r1",
  call_id: "c1",
  ...fields,
});

test("a call's ask, the reviewer, the person's answer and its use read as one row", () => {
  const entries = page([
    notionCall(4, {
      kind: "connector",
      outcome: "ok",
      sentence: "Created pages in Notion",
      detail: "Launch notes",
    }),
    notionCall(3, { kind: "approval", outcome: "allowed", detail: "Launch notes" }),
    notionCall(2, { kind: "review", outcome: "escalated", detail: "Writes to a shared space" }),
    notionCall(1, { kind: "approval", outcome: "asked", detail: "Launch notes" }),
    { id: "0-0", seq: 0, at: 0, kind: "routine", name: "Daily", outcome: "ran" },
  ]);
  const rows = spadeActivityItems(entries).map((item) => item.row);
  expect(rows).toEqual([
    {
      sentence: "Created pages in Notion · you allowed it",
      detail: "Launch notes",
      exception: undefined,
    },
    { sentence: "Daily ran", detail: undefined, exception: undefined },
  ]);
});

test("a call still waiting on the person says so, and a declined one reads as declined", () => {
  const waiting = spadeActivityItems(
    page([
      notionCall(2, { kind: "review", outcome: "escalated" }),
      notionCall(1, { kind: "approval", outcome: "asked", detail: "Launch notes" }),
    ]),
  );
  expect(waiting.map((item) => [item.row.sentence, item.row.exception?.words])).toEqual([
    ["Asked you to create pages in Notion", "Asked you"],
  ]);
  const declined = spadeActivityItems(
    page([
      notionCall(2, { kind: "approval", outcome: "declined" }),
      notionCall(1, { kind: "approval", outcome: "asked" }),
    ]),
  );
  expect(declined.map((item) => item.row.sentence)).toEqual([
    "You declined: create pages in Notion",
  ]);
});

test("the Computer tab's activity is only its computer's use", () => {
  const entries = page([
    { id: "3-0", seq: 3, at: 3, kind: "tool", name: "ace__screen_act", outcome: "ok" },
    notionCall(2, { kind: "connector", outcome: "ok" }),
    { id: "1-0", seq: 1, at: 1, kind: "approval", name: "browser_open", outcome: "allowed" },
    { id: "0-0", seq: 0, at: 0, kind: "tool", name: "shell", outcome: "ok" },
  ]);
  expect(spadeActivityInScope(entries, "computer").map((entry) => entry.name)).toEqual([
    "ace__screen_act",
    "browser_open",
  ]);
  expect(spadeActivityInScope(entries, "all")).toHaveLength(4);
});
