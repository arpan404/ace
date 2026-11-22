import { expect, test } from "vitest";
import { endCut, endLabel } from "./end-name.ts";

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

/*
 * The label a tree row shows for a name in `room` pixels. Measured here as 7px a character (the
 * ellipsis too), so the table reads in characters.
 */
const sevenEach = (text: string) => text.length * 7;

test.each([
  ["a name that fits shows whole", "document.rs", "file", 300, "document.rs"],
  ["a name exactly as wide as its room shows whole", "document.rs", "file", 77, "document.rs"],
  [
    "a name over its room by less than a pixel shows whole (rounding never cuts it)",
    "document.rs",
    "file",
    76.6,
    "document.rs",
  ],
  [
    "a file too long keeps its extension after one ellipsis",
    "workspace-tabs.ts",
    "file",
    70,
    "worksp….ts",
  ],
  ["a folder too long is cut at its end", "adapter-acp", "folder", 56, "adapter…"],
  ["a name with no extension is cut at its end", "LICENSE-APACHE", "file", 56, "LICENSE…"],
  [
    "with no room for a letter before the extension, the name is cut at its end",
    "abcdef.tsx",
    "file",
    35,
    "abcd…",
  ],
  ["with no room at all, only the ellipsis is left", "document.rs", "file", 3, "…"],
] as const)("%s", (_name, name, kind, room, label) => {
  expect(endLabel(name, kind, room, sevenEach)).toBe(label);
});

test("a cut uses one ellipsis character, never dots", () => {
  const label = endLabel("benchmark-document.rs", "file", 100, sevenEach);
  expect(label).toContain("…");
  expect(label).not.toContain("..");
  expect(label.match(/…/g)).toHaveLength(1);
});
