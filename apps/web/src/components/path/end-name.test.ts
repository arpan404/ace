import { expect, test } from "vitest";
import { endCut } from "./end-name.ts";

/*
 * A tree row's name, too long for its row, is cut at its end: a folder as "adapter-ac…", a file
 * keeping its extension, "workspace-ta….ts". `end` always shows; `head` gives way.
 */
test.each([
  ["a folder is cut at its end", "adapter-acp", "folder", "adapter-acp", ""],
  ["a folder with a dot in it is still cut at its end", "release-0.2", "folder", "release-0.2", ""],
  ["a file keeps its extension", "workspace-tabs.ts", "file", "workspace-tabs", ".ts"],
  [
    "a file with several dots keeps only the last",
    "workspace-tabs.test.ts",
    "file",
    "workspace-tabs.test",
    ".ts",
  ],
  ["a dotfile has no extension to keep", ".gitignore", "file", ".gitignore", ""],
  ["a file with no extension is cut at its end", "LICENSE", "file", "LICENSE", ""],
  [
    "a long run after the last dot isn't an extension",
    "notes.this-is-a-long-suffix",
    "file",
    "notes.this-is-a-long-suffix",
    "",
  ],
] as const)("%s", (_name, name, kind, head, end) => {
  expect(endCut(name, kind)).toEqual({ head, end });
});
