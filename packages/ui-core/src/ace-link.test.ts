import { expect, test } from "vitest";
import { readAceLink } from "./ace-link.ts";

test("a thread link names its thread, the message to open at and the machine it is on", () => {
  expect(readAceLink("ace://thread/t-1/item/m-9?machine=studio")).toEqual({
    kind: "thread",
    threadId: "t-1",
    itemId: "m-9",
    machine: "studio",
  });
  expect(readAceLink("ACE://thread/t%2D1")).toEqual({ kind: "thread", threadId: "t-1" });
});

test("ids are opaque: encoded slashes, spaces and long ids reach the thread as written", () => {
  expect(readAceLink("ace://thread/t/item/a%2Fb")).toEqual({
    kind: "thread",
    threadId: "t",
    itemId: "a/b",
  });
  expect(readAceLink("ace://thread/t%201")).toEqual({ kind: "thread", threadId: "t 1" });
  const long = "i".repeat(600);
  expect(readAceLink(`ace://thread/t/item/${long}`)).toMatchObject({ itemId: long });
});

test("settings, new thread and folder links read their one argument", () => {
  expect(readAceLink("ace://settings/machines")).toEqual({ kind: "settings", page: "machines" });
  expect(readAceLink("ace://settings")).toEqual({ kind: "settings" });
  expect(readAceLink("ace://new?project=ace&machine=mac")).toEqual({
    kind: "new-thread",
    project: "ace",
    machine: "mac",
  });
  expect(readAceLink("ace://open?folder=%2FUsers%2Fme%2Fcode")).toEqual({
    kind: "open-folder",
    path: "/Users/me/code",
  });
});

test("anything malformed or foreign is not a link", () => {
  for (const input of [
    "https://thread/t-1",
    "ace://thread",
    "ace://thread/%E0%A4%A",
    "ace://settings/../../etc",
    "ace://thread/t/item",
    "ace://thread/t/other/x",
    "ace://thread/t/item/x/extra",
    "ace://open?folder=relative/path",
    "ace://unknown/x",
    `ace://thread/${"x".repeat(5000)}`,
  ])
    expect(readAceLink(input), input).toBeUndefined();
});
