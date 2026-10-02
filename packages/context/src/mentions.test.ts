import { symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveMentions, PathIndex } from "./index.ts";
import { repository, run } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture() {
  const value = await repository();
  cleanups.push(() => value.close());
  return value;
}

describe("workspace mentions", () => {
  test("folder context excludes nested ignore rules and includes re-included files", async () => {
    const f = await fixture();
    await f.write("src/.gitignore", "*.secret\n!public.secret\n");
    await f.write("src/private.secret", "hidden password");
    await f.write("src/public.secret", "public text");
    await f.write("src/main.ts", "export const answer = 42;");
    await f.workspace.initialize();
    const result = await resolveMentions(f.workspace, [{ path: "src" }]);
    expect(result.entries.map((entry) => entry.path)).toContain("src/public.secret");
    expect(result.entries.map((entry) => entry.path)).toContain("src/main.ts");
    expect(result.entries.some((entry) => entry.text.includes("hidden password"))).toBe(false);
    expect(
      (await resolveMentions(f.workspace, [{ path: "src/private.secret" }])).diagnostics,
    ).toContainEqual(expect.objectContaining({ code: "ignored" }));
  });
  test("tracked files newly ignored disappear from completion and resolution", async () => {
    const f = await fixture();
    await f.write("secret.txt", "private");
    await run("git", ["-C", f.root, "add", "secret.txt"]);
    await f.write(".gitignore", "secret.txt\n");
    await f.workspace.initialize();
    expect(f.workspace.index.complete("secret")).toEqual([]);
    expect(
      (await resolveMentions(f.workspace, [{ path: "secret.txt" }])).diagnostics[0]?.code,
    ).toBe("ignored");
  });
  test("absolute paths and parent traversal never expose outside bytes", async () => {
    const f = await fixture(),
      outside = await fixture();
    await outside.write("secret.txt", "outside bytes");
    for (const path of [join(outside.root, "secret.txt"), "../secret.txt"]) {
      const result = await resolveMentions(f.workspace, [{ path }]);
      expect(result.entries).toEqual([]);
      expect(result.diagnostics[0]?.code).toBe("outside_workspace");
    }
  });
  test("file and directory symlinks cannot escape the workspace", async () => {
    const f = await fixture(),
      outside = await fixture();
    await outside.write("secret.txt", "outside bytes");
    await symlink(join(outside.root, "secret.txt"), join(f.root, "link.txt"));
    await symlink(outside.root, join(f.root, "folder"));
    for (const path of ["link.txt", "folder/secret.txt", "folder"]) {
      const result = await resolveMentions(f.workspace, [{ path }]);
      expect(result.entries).toEqual([]);
      expect(result.diagnostics[0]?.code).toBe("outside_workspace");
    }
  });
  test("binary and invalid UTF-8 mentions return diagnostics without decoding bytes", async () => {
    const f = await fixture();
    await f.write("binary.txt", Buffer.from([65, 0, 66]));
    await f.write("invalid.txt", Buffer.from([255, 255]));
    const result = await resolveMentions(f.workspace, [
      { path: "binary.txt" },
      { path: "invalid.txt" },
    ]);
    expect(result.entries).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toEqual(["binary", "binary"]);
  });
  test("inclusive line ranges include only the selected lines", async () => {
    const f = await fixture();
    await f.write("lines.ts", "one\ntwo\nthree\nfour");
    const result = await resolveMentions(f.workspace, [
      { path: "lines.ts", lines: { start: 2, end: 3 } },
    ]);
    expect(result.entries[0]?.text).toBe("File: lines.ts:2-3\ntwo\nthree");
    expect(result.entries[0]?.truncated).toBe(false);
    expect(
      (await resolveMentions(f.workspace, [{ path: "lines.ts", lines: { start: 10, end: 11 } }]))
        .diagnostics[0]?.code,
    ).toBe("invalid_request");
  });
  test("file caps mark truncation while preserving valid UTF-8", async () => {
    const f = await fixture();
    await f.write("large.txt", "🙂".repeat(100));
    const result = await resolveMentions(f.workspace, [{ path: "large.txt" }], {
      fileBytes: 25,
      totalBytes: 100,
      files: 2,
    });
    expect(result.entries[0]?.truncated).toBe(true);
    expect(result.entries[0]?.text).toContain("[ace: context truncated]");
    expect(result.entries[0]?.text).not.toContain("�");
    expect(Buffer.byteLength(result.entries[0]?.text ?? "")).toBeLessThanOrEqual(100);
  });
  test("a fully available line selection does not inherit later file truncation", async () => {
    const f = await fixture();
    await f.write("lines.txt", "first\nsecond\n" + "later".repeat(100));
    const result = await resolveMentions(
      f.workspace,
      [{ path: "lines.txt", lines: { start: 1, end: 2 } }],
      { fileBytes: 20, totalBytes: 200, files: 2 },
    );
    expect(result.entries[0]?.text).toBe("File: lines.txt:1-2\nfirst\nsecond");
    expect(result.entries[0]?.truncated).toBe(false);
  });
  test("aggregate and folder file caps limit expansion with diagnostics", async () => {
    const f = await fixture();
    await f.write("src/a.txt", "a".repeat(100));
    await f.write("src/b.txt", "b".repeat(100));
    await f.workspace.initialize();
    const result = await resolveMentions(f.workspace, [{ path: "src" }], {
      fileBytes: 200,
      totalBytes: 80,
      files: 10,
    });
    expect(
      result.entries.reduce((bytes, entry) => bytes + Buffer.byteLength(entry.text), 0),
    ).toBeLessThanOrEqual(80);
    expect(result.entries[0]?.text).toContain("[ace: context truncated]");
    expect(result.diagnostics.some((item) => item.message.includes("Folder"))).toBe(true);
    const capped = await resolveMentions(f.workspace, [{ path: "src" }], {
      fileBytes: 200,
      totalBytes: 1000,
      files: 1,
    });
    expect(capped.entries).toHaveLength(1);
    expect(capped.diagnostics[0]?.code).toBe("truncated");
  });
  test("incremental index updates add, delete and honor changed ignore rules", async () => {
    const f = await fixture();
    await f.write("old.ts", "old");
    await f.workspace.initialize();
    await f.write("src/new-module.ts", "new");
    await rm(join(f.root, "old.ts"));
    await f.workspace.update(["old.ts", "src/new-module.ts"]);
    expect(f.workspace.index.complete("snm")).toEqual(["src/new-module.ts"]);
    expect(f.workspace.index.complete("old")).toEqual([]);
    await f.write(".gitignore", "src/\n");
    await f.workspace.update([".gitignore"]);
    expect(f.workspace.index.complete("snm")).toEqual([]);
  });
  test("directory creation and removal update descendants in the cached index", async () => {
    const f = await fixture();
    await f.workspace.initialize();
    await f.write("new/inner/a.ts", "new");
    await f.workspace.update(["new"]);
    expect(f.workspace.index.complete("nia")).toEqual(["new/inner/a.ts"]);
    await rm(join(f.root, "new"), { recursive: true });
    await f.workspace.update(["new"]);
    expect(f.workspace.index.complete("nia")).toEqual([]);
  });
  test("fuzzy completion ranks closer matches and stops at the result cap", () => {
    const index = new PathIndex(4);
    for (const path of ["src/very-long-main.ts", "src/main.ts", "src/mapping.ts"])
      index.update(path, true);
    expect(index.complete("smn", 1)).toEqual(["src/main.ts"]);
    expect(index.complete("zzz")).toEqual([]);
    index.update("src/main.ts", false);
    expect(index.complete("smn")).not.toContain("src/main.ts");
    expect(() => {
      index.update("x", true);
      index.update("y", true);
      index.update("z", true);
    }).toThrow("Workspace index limit");
  });
});
