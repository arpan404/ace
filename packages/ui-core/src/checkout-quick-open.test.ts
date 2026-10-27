import { expect, test } from "vitest";
import {
  closeInList,
  moveInList,
  openInList,
  parseQuickOpen,
  putScoped,
  quickOpenRows,
  rememberScoped,
  scopedList,
} from "./checkout-quick-open.ts";

test("a typed path:line finds the file and keeps the line", () => {
  expect(parseQuickOpen(" src/app.ts:42 ")).toEqual({ query: "src/app.ts", line: 42 });
  expect(parseQuickOpen("app")).toEqual({ query: "app", line: undefined });
  expect(parseQuickOpen(":12")).toEqual({ query: ":12", line: undefined });
});

test("with a query quick open offers the daemon's file matches in its order, never folders", () => {
  expect(quickOpenRows("app", ["src/app.ts", "src/", "app.md"], ["x.ts"], ["y.ts"])).toEqual([
    { path: "src/app.ts", group: "Files" },
    { path: "app.md", group: "Files" },
  ]);
});

test("with nothing typed quick open offers recent files, then changed files not already shown", () => {
  const recent = Array.from({ length: 10 }, (_, index) => `r${index}.ts`);
  const rows = quickOpenRows("", [], recent, ["r1.ts", "c.ts"], "Changed");
  expect(rows.filter((row) => row.group === "Opened recently")).toHaveLength(8);
  expect(rows.filter((row) => row.group === "Changed").map((row) => row.path)).toEqual(["c.ts"]);
});

test("recent files are kept per thread, newest first, within both limits", () => {
  const limits = { perScope: 2, scopes: 2 };
  let lists = rememberScoped([], "a", "one.ts", limits);
  lists = rememberScoped(lists, "a", "two.ts", limits);
  lists = rememberScoped(lists, "a", "three.ts", limits);
  expect(scopedList(lists, "a")).toEqual(["three.ts", "two.ts"]);
  lists = rememberScoped(lists, "b", "b.ts", limits);
  lists = rememberScoped(lists, "c", "c.ts", limits);
  expect(scopedList(lists, "a")).toEqual([]);
  expect(lists.map(([scope]) => scope)).toEqual(["c", "b"]);
});

test("a thread whose list empties is dropped", () => {
  const lists = putScoped([["a", ["x"]]], "a", [], { perScope: 4, scopes: 4 });
  expect(lists).toEqual([]);
});

test("open files keep their order; reopening keeps the place and the oldest goes past the limit", () => {
  let open = openInList([], "a.ts", 3);
  open = openInList(open, "b.ts", 3);
  open = openInList(open, "a.ts", 3);
  expect(open).toEqual(["a.ts", "b.ts"]);
  open = openInList(openInList(open, "c.ts", 3), "d.ts", 3);
  expect(open).toEqual(["b.ts", "c.ts", "d.ts"]);
});

test("closing a folder closes the files inside it", () => {
  expect(closeInList(["src/a.ts", "src/b/c.ts", "readme.md"], "src/")).toEqual(["readme.md"]);
  expect(closeInList(["src/a.ts", "readme.md"], "src/a.ts")).toEqual(["readme.md"]);
});

test("a rename carries open entries at and inside the old path to the new one", () => {
  expect(moveInList(["src/a.ts", "srcx.ts", "lib/b.ts"], "src", "app")).toEqual([
    "app/a.ts",
    "srcx.ts",
    "lib/b.ts",
  ]);
  expect(moveInList(["a.ts", "b.ts"], "a.ts", "b.ts")).toEqual(["b.ts"]);
});
