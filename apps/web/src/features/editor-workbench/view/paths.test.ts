import { expect, test } from "vitest";
import { folderTail } from "./paths.ts";

/*
 * A folder in a narrow row loses its middle first: everything before its nearest folder
 * truncates to "…", and only then does the nearest folder itself clip ("…/wor…"). The tail is
 * the part kept longest.
 */
test.each([
  [
    "a deep folder keeps its nearest folder with its slash",
    "apps/web/src/lib/workspace",
    "/workspace",
  ],
  ["a short folder keeps its nearest folder", "packages/ui-core/src", "/src"],
  ["one folder is all tail", "src", "src"],
  ["a file at the checkout's root has no folder", "", ""],
] as const)("%s", (_name, folder, tail) => {
  expect(folder.slice(folder.length - folderTail(folder))).toBe(tail);
});
