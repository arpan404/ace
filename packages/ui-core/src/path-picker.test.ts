import { expect, test } from "vitest";
import {
  choosePath,
  pathRows,
  startText,
  stepHighlight,
  typedFolder,
  type PathEntry,
} from "./path-picker.ts";

const code = "/home/dev/code";
const entries: PathEntry[] = [
  { name: "next-app", path: `${code}/next-app` },
  { name: "weather", path: `${code}/weather` },
];

test("Enter with nothing highlighted never creates a folder that doesn't exist", () => {
  // `~/code/next` where only next-app exists: the typed folder is missing.
  const typed = typedFolder({ directory: code, segment: "next", entries });
  expect(typed).toBeUndefined();
  expect(choosePath(undefined, "open", typed)).toEqual({ kind: "none" });
  expect(choosePath(undefined, "add", typed)).toEqual({ kind: "none" });
});

test("Enter with nothing highlighted adds the typed folder when it exists", () => {
  const typed = typedFolder({ directory: code, segment: "weather", entries });
  expect(choosePath(undefined, "open", typed)).toEqual({ kind: "add", path: `${code}/weather` });
  // A trailing slash names the folder being browsed.
  const browsed = typedFolder({ directory: code, segment: "", entries });
  expect(choosePath(undefined, "open", browsed)).toEqual({ kind: "add", path: code });
});

test("a missing folder is made only when its own row is chosen", () => {
  const rows = pathRows({
    directory: code,
    segment: "next",
    matches: entries.slice(0, 1),
    missing: { path: `${code}/next`, name: "next" },
  });
  expect(rows.map((row) => row.kind)).toEqual(["folder", "create"]);
  expect(choosePath(rows[1], "open", undefined)).toEqual({ kind: "create", path: `${code}/next` });
  // The matching folder above it goes in on Enter and is added on ⌘Enter; neither creates.
  expect(choosePath(rows[0], "open", undefined)).toEqual({
    kind: "browse",
    path: `${code}/next-app`,
  });
  expect(choosePath(rows[0], "add", undefined)).toEqual({ kind: "add", path: `${code}/next-app` });
});

test("browsing a folder offers .. first, which goes up", () => {
  const rows = pathRows({ directory: code, segment: "", matches: entries, missing: undefined });
  expect(rows[0]).toEqual({ kind: "up", path: "/home/dev" });
  expect(choosePath(rows[0], "open", code)).toEqual({ kind: "browse", path: "/home/dev" });
  // Nothing above the root.
  expect(pathRows({ directory: "/", segment: "", matches: [], missing: undefined })).toEqual([]);
});

test("the typed folder is found when only its case differs", () => {
  expect(typedFolder({ directory: code, segment: "Weather", entries })).toBe(`${code}/weather`);
  // Until the folder has been listed nothing is known to exist.
  expect(typedFolder({ directory: code, segment: "", entries: undefined })).toBeUndefined();
});

test("arrows start from nothing highlighted and wrap", () => {
  expect(stepHighlight(undefined, 1, 3)).toBe(0);
  expect(stepHighlight(undefined, -1, 3)).toBe(2);
  expect(stepHighlight(2, 1, 3)).toBe(0);
  expect(stepHighlight(0, -1, 3)).toBe(2);
  expect(stepHighlight(undefined, 1, 0)).toBeUndefined();
});

test("the field starts beside the most recent project, else where browsing opens", () => {
  expect(startText([`${code}/weather`, "/srv/x"], "/home/dev", "/home/dev")).toBe("~/code/");
  expect(startText(["/srv/apps/x"], "/home/dev", "/home/dev")).toBe("/srv/apps/");
  expect(startText([], "/home/dev", "/home/dev")).toBe("~/");
  // Home outside the allowed places: the first of them.
  expect(startText([], "/home/dev", "/srv")).toBe("/srv/");
  expect(startText([], undefined, undefined)).toBe("~/");
});
