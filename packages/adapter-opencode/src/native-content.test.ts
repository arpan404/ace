import { describe, expect, it } from "vitest";
import { editChanges } from "./native-content.ts";

const patch = "--- a.ts\n+++ a.ts\n@@ -1,1 +1,2 @@\n a\n+b\n";

describe("an OpenCode edit's file changes", () => {
  it("carry the one patch an older OpenCode reports as metadata.diff", () => {
    expect(editChanges("a.ts", { diff: patch })).toEqual([
      { path: "a.ts", kind: "update", diff: patch },
    ]);
  });
  it("mark a file the write created as added", () => {
    expect(editChanges("a.ts", { files: [{ file: "a.ts", patch, status: "added" }] })).toEqual([
      { path: "a.ts", kind: "add", diff: patch },
    ]);
  });
  it("name each file by its own entry when one call reports several", () => {
    const files = [
      { file: "a.ts", patch, status: "modified" },
      { file: "b.ts", patch, status: "deleted" },
    ];
    expect(editChanges("a.ts", { files })).toEqual([
      { path: "a.ts", kind: "update", diff: patch },
      { path: "b.ts", kind: "delete", diff: patch },
    ]);
  });
  it("are left to the path alone when OpenCode sent no patch", () => {
    expect(editChanges("a.ts", { truncated: false })).toBeUndefined();
  });
});
