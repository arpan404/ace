import { expect, test } from "vitest";
import { folderVariants } from "./paths.ts";

/*
 * A folder shown in a narrow row gives way in its middle by whole folders, longest form first:
 * it keeps its first folders and its nearest one, never a chopped name or two names run together.
 */
test.each([
  ["a file at the checkout's root shows no folder", "", []],
  ["one folder has one form", "src", ["src"]],
  ["two folders only drop the first whole", "apps/web", ["apps/web", "…/web"]],
  [
    "three folders keep the first and the nearest",
    "packages/ui-core/src",
    ["packages/ui-core/src", "packages/…/src", "…/src"],
  ],
  [
    "a deep folder gives way one folder at a time from its middle",
    "apps/web/src/lib/workspace",
    [
      "apps/web/src/lib/workspace",
      "apps/web/src/…/workspace",
      "apps/web/…/workspace",
      "apps/…/workspace",
      "…/workspace",
    ],
  ],
] as const)("%s", (_name, folder, forms) => {
  expect(folderVariants(folder)).toEqual(forms);
});
