import { expect, test } from "vitest";
import { folderLabel } from "./folder-label.ts";

/*
 * A folder beside a file name in a narrow row keeps its nearest folders: whole leading folders
 * drop first, then "…/" and the nearest folder, then that folder's own name cut at its end. It
 * never shows a one-letter fragment; with no room for 4 letters of the nearest folder it shows
 * nothing (the row's tooltip has the path). Rooms are in characters here.
 */
const chars = (text: string) => [...text].length;

test.each([
  [
    "a deep folder with room shows whole",
    "apps/web/src/lib/workspace",
    40,
    "apps/web/src/lib/workspace",
  ],
  [
    "a deep folder drops whole leading folders first",
    "apps/web/src/lib/workspace",
    20,
    "src/lib/workspace",
  ],
  ["then down to its last two", "apps/web/src/lib/workspace", 13, "lib/workspace"],
  ["then the nearest folder after …/", "apps/web/src/lib/workspace", 12, "…/workspace"],
  ["then the nearest folder's name cut at its end", "apps/web/src/lib/workspace", 9, "…/worksp…"],
  ["with 4 letters of it, still cut at its end", "apps/web/src/lib/workspace", 7, "…/work…"],
  ["with room for fewer than 4 letters, nothing", "apps/web/src/lib/workspace", 6, ""],
  ["a short folder drops its first folder", "packages/ui-core/src", 11, "ui-core/src"],
  ["then …/ and its nearest", "packages/ui-core/src", 6, "…/src"],
  ["a nearest folder too short to cut shows nothing past that", "packages/ui-core/src", 4, ""],
  ["one folder shows whole", "workspace", 9, "workspace"],
  ["one folder is cut at its end", "workspace", 7, "worksp…"],
  ["one short folder that doesn't fit shows nothing", "src", 2, ""],
  ["a file at the checkout's root shows no folder", "", 40, ""],
] as const)("%s", (_name, folder, room, label) => {
  expect(folderLabel(folder, room, chars)).toBe(label);
});
