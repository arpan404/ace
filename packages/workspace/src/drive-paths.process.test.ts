import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import { describe, expect, test } from "vitest";
import { createWorkspace } from "./index.ts";
import { batches, exec, fixture } from "./test-support.ts";

// Paths, names and errors as Windows users meet them. POSIX hosts have their own cases.
describe.runIf(process.platform === "win32")("Windows project paths", () => {
  test("names a file used as a folder as not a directory, and a missing path as not found", async () => {
    const { service, root, file } = await fixture();
    await file("a.txt", "hi");
    await expect(service.read({ path: "missing" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.read({ path: "dir/missing" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(service.read({ path: "" })).rejects.toMatchObject({ code: "NOT_FILE" });
    await expect(service.list({ dir: "a.txt" })).rejects.toMatchObject({ code: "NOT_DIRECTORY" });
    await expect(service.read({ path: "a.txt/child" })).rejects.toMatchObject({
      code: "NOT_DIRECTORY",
    });
    await expect(service.list({ dir: "a.txt/child" })).rejects.toMatchObject({
      code: "NOT_DIRECTORY",
    });
    await expect(createWorkspace(join(root, "a.txt"))).rejects.toMatchObject({
      code: "NOT_DIRECTORY",
    });
  });

  test("refuses network and device roots with a message that says so", async () => {
    await expect(createWorkspace("\\\\server\\share\\project")).rejects.toMatchObject({
      code: "INVALID_PATH",
      message: expect.stringMatching(/network/i),
    });
    await expect(createWorkspace("\\\\?\\C:\\project")).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
    await expect(createWorkspace("\\\\.\\PhysicalDrive0")).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
  });

  test("opens a root given with a lowercase drive letter or forward slashes", async () => {
    const { root, file } = await fixture();
    await file("src/a.ts", "needle");
    const canonical = await realpath(root);
    for (const spelling of [
      canonical.charAt(0).toLowerCase() + canonical.slice(1),
      canonical.replaceAll("\\", "/"),
    ]) {
      const service = await createWorkspace(spelling);
      expect(service.root).toBe(canonical);
      expect((await service.list({ dir: "", depth: 2 })).entries.map((e) => e.path)).toEqual([
        "src",
        "src/a.ts",
      ]);
      expect((await service.read({ path: "src/a.ts" })).bytesRead).toBe(6);
    }
  });

  test("lists, reads and searches Unicode names", async () => {
    const { service, file } = await fixture();
    await file("café/日本語.ts", "const naïve = 'needle';\n");
    await file("emoji 😀.md", "needle\n");
    expect((await service.list({ dir: "", depth: 2 })).entries.map((e) => e.path)).toEqual([
      "café",
      "café/日本語.ts",
      "emoji 😀.md",
    ]);
    expect(await service.read({ path: "café/日本語.ts" })).toMatchObject({
      text: "const naïve = 'needle';\n",
    });
    expect((await service.search({ query: "needle", limit: 10 })).matches).toEqual([
      { path: "café/日本語.ts", line: 1, column: 17, preview: "const naïve = 'needle';" },
      { path: "emoji 😀.md", line: 1, column: 1, preview: "needle" },
    ]);
  });

  test("lists, reads, searches and watches paths longer than 260 characters", async () => {
    const { service, root } = await fixture();
    const parts = Array.from({ length: 6 }, (_, index) => `${index}`.padEnd(60, "d"));
    const deep = parts.join("/");
    await mkdir(join(root, ...parts), { recursive: true });
    await writeFile(join(root, ...parts, "long.ts"), "needle\n");
    expect(join(root, ...parts, "long.ts").length).toBeGreaterThan(260);
    const listed = await service.list({ dir: "", depth: 10 });
    expect(listed.entries.map((e) => e.path)).toContain(`${deep}/long.ts`);
    expect(await service.read({ path: `${deep}/long.ts` })).toMatchObject({ text: "needle\n" });
    expect((await service.search({ query: "needle", limit: 10 })).matches).toEqual([
      { path: `${deep}/long.ts`, line: 1, column: 1, preview: "needle" },
    ]);
    const events = batches();
    const watcher = await service.watch({ onChange: events.onChange });
    try {
      expect(watcher.mode).toBe("native");
      const created = events.next(`${deep}/new.ts`, "created");
      await writeFile(join(root, ...parts, "new.ts"), "new");
      await created;
    } finally {
      await watcher.dispose();
    }
  });

  test("refuses reserved device names and hides Git folders in any case or 8.3 alias", async () => {
    const { service, root, file } = await fixture({}, true);
    await file("src/a.ts", "a");
    for (const path of ["CON", "nul.txt", "src/aux", "COM1.log", "a:stream", "trailing."])
      await expect(service.read({ path })).rejects.toMatchObject({ code: "INVALID_PATH" });
    const all = await service.list({ dir: "", depth: 5, includeIgnored: true });
    expect(all.entries.map((e) => e.path)).toEqual(["src", "src/a.ts"]);
    expect((await service.list({ dir: ".GIT" })).entries).toEqual([]);
    const alias = join(root, "GIT~1");
    // The workflow turns on 8.3 names for the temp volume; elsewhere the alias may not exist.
    if ((await realpath(alias).catch(() => "")) === join(await realpath(root), ".git"))
      expect((await service.list({ dir: "GIT~1" })).entries).toEqual([]);
  });

  test("keeps nested ignore rules and negations, and tracked files, visible correctly", async () => {
    const { service, root, file } = await fixture({}, true);
    await file(".gitignore", "*.log\ncache/\n!keep.log\n");
    await file("hide.log", "hidden");
    await file("keep.log", "visible");
    await file("tracked.log", "tracked");
    await file("cache/deep.txt", "hidden");
    await file("src/.gitignore", "*.txt\n!keep.txt\n");
    await file("src/hide.txt", "hidden");
    await file("src/keep.txt", "visible");
    await exec("git", ["-C", root, "add", "-f", "tracked.log"]);
    expect((await service.list({ dir: "", depth: 5 })).entries.map((e) => e.path)).toEqual([
      ".gitignore",
      "keep.log",
      "src",
      "src/.gitignore",
      "src/keep.txt",
      "tracked.log",
    ]);
    const all = (await service.list({ dir: "", depth: 5, includeIgnored: true })).entries;
    expect(all.find((e) => e.path === "cache/deep.txt")).toMatchObject({ ignored: true });
    expect(all.some((e) => e.path.toLowerCase().startsWith(".git/"))).toBe(false);
  });

  test("Node search skips ignored, Git, binary and linked files and matches CRLF, case and globs", async () => {
    const { service, root, file } = await fixture({}, true);
    await file(".gitignore", "ignored/\n*.log\n");
    await file("a.ts", "café needle needle\r\nNEEDLE\r\nalpha42\r\n");
    await file("sub/b.ts", "needle\r\nalpha7\r\n");
    await file(".hidden.ts", "needle\n");
    await file("c.txt", "needle\n");
    await file("ignored/a.ts", "needle\n");
    await file("hidden.log", "needle\n");
    await file(".git/needle.ts", "needle\n");
    await file("binary.ts", Buffer.from("needle\0needle"));
    const outside = await fixture();
    await outside.file("secret.ts", "needle");
    await symlink(outside.root, join(root, "escape"), "junction");
    const paths = async (request: Parameters<typeof service.search>[0]) => {
      const result = await service.search(request);
      expect(result.backend).toBe("node");
      return result.matches.map((m) => `${m.path}:${m.line}:${m.column}`);
    };
    expect(await paths({ query: "needle", limit: 100 })).toEqual([
      ".hidden.ts:1:1",
      "a.ts:1:7",
      "a.ts:1:14",
      "c.txt:1:1",
      "sub/b.ts:1:1",
    ]);
    expect(
      await paths({ query: "needle", caseSensitive: false, glob: "a.ts", limit: 100 }),
    ).toEqual(["a.ts:1:7", "a.ts:1:14", "a.ts:2:1"]);
    expect(
      await paths({ query: "^alpha[0-9]+$", regex: true, glob: "**/*.ts", limit: 100 }),
    ).toEqual(["a.ts:3:1", "sub/b.ts:2:1"]);
    // Windows users type backslashes; Node's Windows glob treats them as separators.
    expect(await paths({ query: "alpha", glob: "sub\\*.ts", limit: 100 })).toEqual([
      "sub/b.ts:2:1",
    ]);
    expect(await paths({ query: "needle", glob: "*.txt", limit: 100 })).toEqual(["c.txt:1:1"]);
    // Literal queries skip files that can't match; Unicode case folding must still find these.
    await file("fold.md", "\u212Aelvin and \u017Fign\r\nKELVIN\r\n");
    expect(
      await paths({ query: "kelvin", caseSensitive: false, glob: "*.md", limit: 100 }),
    ).toEqual(["fold.md:1:1", "fold.md:2:1"]);
    expect(await paths({ query: "sign", caseSensitive: false, glob: "*.md", limit: 100 })).toEqual([
      "fold.md:1:14",
    ]);
    expect(await paths({ query: "KELVIN", glob: "*.md", limit: 100 })).toEqual(["fold.md:2:1"]);
  });

  test("finds matches across 20,000 files within a generous bound", async () => {
    const { service, root } = await fixture();
    const directories = 200;
    for (let d = 0; d < directories; d++) {
      const dir = join(root, `pkg${d}`);
      await mkdir(dir);
      await Promise.all(
        Array.from({ length: 100 }, (_, f) =>
          writeFile(join(dir, `f${f}.ts`), f === 0 ? "export const needle = 1;\n" : "export {};\n"),
        ),
      );
    }
    const start = performance.now();
    const result = await service.search({ query: "needle", limit: 10_000 });
    const milliseconds = performance.now() - start;
    console.log(JSON.stringify({ search: "20k files", milliseconds, bytes: result.bytesScanned }));
    expect(result.matches).toHaveLength(directories);
    // Each file is one native open relative to its held folder; ARM64 runners are slower.
    expect(milliseconds).toBeLessThan(process.arch === "arm64" ? 30_000 : 10_000);
  }, 180_000);
});

// Lexical checks shared with the request validator, through the public path rules.
test.runIf(process.platform === "win32")(
  "treats a drive-relative or UNC request path as invalid",
  async () => {
    const { service } = await fixture();
    for (const path of ["C:a.ts", "C:\\a.ts", "\\\\server\\share", win32.join("a", "b")])
      await expect(service.read({ path })).rejects.toMatchObject({ code: "INVALID_PATH" });
  },
);
