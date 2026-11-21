import { expect, test } from "vitest";
import { folderEnds } from "./paths.ts";

/*
 * A folder shown in a narrow row gives way in its middle: its start truncates, its nearest
 * folder always shows ("apps/web/…/shell").
 */
test.each([
  [
    "a deep folder keeps its nearest part whole",
    "apps/web/src/features/shell",
    "apps/web/src/features/",
    "shell",
  ],
  ["one folder is all nearest part", "src", "", "src"],
  ["the checkout's root has nothing to show", "", "", ""],
] as const)("%s", (_name, folder, head, tail) => {
  expect(folderEnds(folder)).toEqual({ head, tail });
});
