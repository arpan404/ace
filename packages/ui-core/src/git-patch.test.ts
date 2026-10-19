import { expect, test } from "vitest";
import { gitPatchFiles } from "./git-patch.ts";
import { patchFiles } from "./mobile-changes.ts";

const patch = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,3 @@",
  " import { run } from './run';",
  "-run(1);",
  "+run(2);",
  " export {};",
  "@@ -20,2 +20,3 @@ function tail()",
  " a",
  "+b",
  " c",
  "diff --git a/notes.md b/notes.md",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/notes.md",
  "@@ -0,0 +1,2 @@",
  "+# Notes",
  "+Second line",
  "diff --git a/old.txt b/old.txt",
  "deleted file mode 100644",
  "--- a/old.txt",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-gone",
  "diff --git a/lib/a.ts b/lib/b.ts",
  "similarity index 90%",
  "rename from lib/a.ts",
  "rename to lib/b.ts",
  "--- a/lib/a.ts",
  "+++ b/lib/b.ts",
  "@@ -1 +1 @@",
  "-export const a = 1;",
  "+export const b = 1;",
  "diff --git a/logo.png b/logo.png",
  "index 4444444..5555555 100644",
  "Binary files a/logo.png and b/logo.png differ",
  "diff --git a/my file.txt b/my file.txt",
  "old mode 100644",
  "new mode 100755",
  "",
].join("\n");

test("a git patch reads as one diff per file with its status and counts", () => {
  const files = gitPatchFiles(patch);
  expect(
    files.map(({ path, status, movedFrom, additions, deletions }) => ({
      path,
      status,
      movedFrom,
      additions,
      deletions,
    })),
  ).toEqual([
    { path: "src/app.ts", status: "modified", movedFrom: undefined, additions: 2, deletions: 1 },
    { path: "notes.md", status: "added", movedFrom: undefined, additions: 2, deletions: 0 },
    { path: "old.txt", status: "deleted", movedFrom: undefined, additions: 0, deletions: 1 },
    { path: "lib/b.ts", status: "moved", movedFrom: "lib/a.ts", additions: 1, deletions: 1 },
    { path: "logo.png", status: "modified", movedFrom: undefined, additions: 0, deletions: 0 },
    { path: "my file.txt", status: "modified", movedFrom: undefined, additions: 0, deletions: 0 },
  ]);
});

test("each file's lines keep their old and new numbers, with the gap between hunks folded", () => {
  const [app] = gitPatchFiles(patch);
  expect(app?.rows).toEqual([
    { kind: "context", old: 1, new: 1, text: "import { run } from './run';" },
    { kind: "del", old: 2, text: "run(1);" },
    { kind: "add", new: 2, text: "run(2);" },
    { kind: "context", old: 3, new: 3, text: "export {};" },
    { kind: "fold", count: 16 },
    { kind: "context", old: 20, new: 20, text: "a" },
    { kind: "add", new: 21, text: "b" },
    { kind: "context", old: 21, new: 22, text: "c" },
  ]);
  // Headers and the next file's lines never leak into a file's rows.
  expect(app?.rows.some((row) => row.kind !== "fold" && row.text.includes("diff --git"))).toBe(
    false,
  );
});

test("quoted paths with escaped UTF-8 read as the file's real name", () => {
  const quoted = [
    'diff --git "a/caf\\303\\251 \\"menu\\".txt" "b/caf\\303\\251 \\"menu\\".txt"',
    "index 1..2 100644",
    '--- "a/caf\\303\\251 \\"menu\\".txt"',
    '+++ "b/caf\\303\\251 \\"menu\\".txt"',
    "@@ -1 +1 @@",
    "-a",
    "+b",
  ].join("\n");
  expect(gitPatchFiles(quoted).map((file) => file.path)).toEqual(['café "menu".txt']);
});

test("a patch cut short keeps the rows it has", () => {
  const cut = patch.slice(0, patch.indexOf("+run(2);"));
  const [app] = gitPatchFiles(cut);
  expect(app?.rows.map((row) => row.kind)).toEqual(["context", "del"]);
});

test("the native Changes sheet still finds each file's section by path", () => {
  const sections = patchFiles(patch);
  expect([...sections.keys()]).toEqual([
    "src/app.ts",
    "notes.md",
    "old.txt",
    "lib/b.ts",
    "logo.png",
    "my file.txt",
  ]);
  expect(sections.get("old.txt")).toContain("-gone");
  expect(sections.get("old.txt")).not.toContain("lib/a.ts");
});
