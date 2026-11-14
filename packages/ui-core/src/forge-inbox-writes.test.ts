import type { ForgeInboxList, ForgeInboxRow, ForgeRepository } from "@ace/protocol";
import { expect, test } from "vitest";
import { afterWrite, markAllReadWrites, readAllApplying } from "./forge-inbox-writes.ts";

const ace = { forge: "github", host: "github.com", owner: "acme", name: "ace" } as const;
const docs = { ...ace, name: "docs-site" } as const;
const row = (
  id: string,
  updatedAt: string,
  repository: ForgeRepository = ace,
  unread = true,
): ForgeInboxRow => ({
  id,
  repository,
  type: "Issue",
  title: id,
  reason: "mention",
  unread,
  updatedAt,
  lastReadAt: null,
});
const page = (items: ForgeInboxRow[]): ForgeInboxList => ({
  host: "github.com",
  items,
  pollSeconds: 60,
  unchanged: false,
});
const unread = (list: ForgeInboxList) =>
  list.items.filter((each) => each.unread).map((each) => each.id);

test("Mark all read clears what GitHub had by the press and leaves anything newer unread", () => {
  const list = page([row("old", "2026-11-12T10:00:00Z"), row("new", "2026-11-12T10:05:00Z")]);
  const before = Date.parse("2026-11-12T10:01:00Z");
  expect(unread(afterWrite(list, { kind: "read-all", before }))).toEqual(["new"]);
});

test("Mark all read in one repository leaves the others' rows unread", () => {
  const list = page([row("a", "2026-11-12T10:00:00Z"), row("d", "2026-11-12T10:00:00Z", docs)]);
  const before = Date.parse("2026-11-12T11:00:00Z");
  expect(unread(afterWrite(list, { kind: "read-all", before, repository: docs }))).toEqual(["a"]);
});

test("a row marked read loses its dot and a row marked done leaves the page", () => {
  const list = page([row("a", "2026-11-12T10:00:00Z"), row("b", "2026-11-12T10:00:00Z")]);
  expect(unread(afterWrite(list, { kind: "read", ids: new Set(["a"]) }))).toEqual(["b"]);
  expect(
    afterWrite(list, { kind: "done", ids: new Set(["a"]) }).items.map((each) => each.id),
  ).toEqual(["b"]);
});

test("Mark all read sends one write up to the press unless the rows on show are narrowed", () => {
  const before = Date.parse("2026-11-12T10:01:00Z");
  expect(markAllReadWrites({ narrowed: false, unread: ["a", "b"], before })).toEqual([
    { action: "read-all", before: "2026-11-12T10:01:00.000Z" },
  ]);
  expect(markAllReadWrites({ narrowed: false, unread: ["a"], before, repository: docs })).toEqual([
    { action: "read-all", before: "2026-11-12T10:01:00.000Z", repository: docs },
  ]);
  // GitHub can't mark only one reason's or a search's rows: each shown unread row goes alone.
  expect(markAllReadWrites({ narrowed: true, unread: ["a", "b"], before })).toEqual([
    { action: "read", id: "a" },
    { action: "read", id: "b" },
  ]);
});

test("Mark all read's change holds for one poll interval while GitHub applies it", () => {
  expect(readAllApplying(1_000, 60_999, 60)).toBe(true);
  expect(readAllApplying(1_000, 61_000, 60)).toBe(false);
  expect(readAllApplying(undefined, 1_000, 60)).toBe(false);
});
