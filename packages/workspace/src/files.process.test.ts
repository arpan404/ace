import { mkdir, rename, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkspace } from "./index.ts";
import { exec, fixture } from "./test-support.ts";

function cursor(value: string | null): string {
  if (value === null) throw new Error("Expected another listing page");
  return value;
}

describe("workspace paths and files", () => {
  it("rejects traversal and absolute paths even when normalization would stay inside", async () => {
    const { service } = await fixture();
    for (const path of [
      "../secret",
      "x/../a",
      "/tmp/secret",
      "C:/secret",
      "\\\\server\\share",
      "a\0b",
    ]) {
      await expect(service.read({ path })).rejects.toMatchObject({ code: "INVALID_PATH" });
      await expect(service.list({ dir: path })).rejects.toMatchObject({ code: "INVALID_PATH" });
    }
  });
  it("rejects file and directory symlinks outside the root and allows a safe file link", async () => {
    const inside = await fixture();
    const outside = await fixture();
    await outside.file("secret", "outside");
    await inside.file("safe", "inside");
    await symlink(join(outside.root, "secret"), join(inside.root, "escape"));
    await symlink(outside.root, join(inside.root, "escape-dir"));
    await symlink("safe", join(inside.root, "alias"));
    await expect(inside.service.read({ path: "escape" })).rejects.toMatchObject({
      code: "PATH_ESCAPE",
    });
    await expect(inside.service.read({ path: "escape-dir/secret" })).rejects.toMatchObject({
      code: "PATH_ESCAPE",
    });
    await expect(inside.service.list({ dir: "escape-dir" })).rejects.toMatchObject({
      code: "PATH_ESCAPE",
    });
    expect(await inside.service.read({ path: "alias" })).toMatchObject({ text: "inside" });
    expect((await inside.service.list({ dir: "" })).entries.map((entry) => entry.path)).toEqual([
      "alias",
      "safe",
    ]);
  });
  it("lists an in-root directory link with the target directory's git ignore rules", async () => {
    const { service, root, file } = await fixture({}, true);
    await file("real/.gitignore", "*.log\n");
    await file("real/keep.ts", "visible");
    await file("real/hide.log", "hidden");
    await symlink("real", join(root, "alias"));
    expect((await service.list({ dir: "alias" })).entries.map((entry) => entry.path)).toEqual([
      "alias/.gitignore",
      "alias/keep.ts",
    ]);
    expect(
      (await service.list({ dir: "alias", includeIgnored: true })).entries.find(
        (entry) => entry.path === "alias/hide.log",
      ),
    ).toMatchObject({ ignored: true });
  });
  it("rejects intermediate links that escape before linking back into the workspace", async () => {
    const inside = await fixture();
    const outside = await fixture();
    await inside.file("safe", "inside");
    await symlink(outside.root, join(inside.root, "out"));
    await symlink(inside.root, join(outside.root, "back"));
    await expect(inside.service.read({ path: "out/back/safe" })).rejects.toMatchObject({
      code: "PATH_ESCAPE",
    });
  });
  it("refuses operations after the root is replaced", async () => {
    const { root, service, file } = await fixture();
    await file("a", "original");
    const moved = join(root, "moved");
    // Move the original root out of its pathname and recreate that pathname.
    const backup = root + "-backup";
    await rename(root, backup);
    await mkdir(root);
    await rename(backup, moved);
    await expect(service.read({ path: "moved/a" })).rejects.toMatchObject({ code: "PATH_CHANGED" });
    await expect(service.search({ query: "original", limit: 5 })).rejects.toMatchObject({
      code: "PATH_CHANGED",
    });
  });
  it("returns typed missing-file and wrong-kind errors", async () => {
    const { service, file } = await fixture();
    await file("a", "hi");
    await expect(service.read({ path: "missing" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.read({ path: "" })).rejects.toMatchObject({ code: "NOT_FILE" });
    await expect(service.list({ dir: "a" })).rejects.toMatchObject({ code: "NOT_DIRECTORY" });
    await expect(createWorkspace("/dev/null")).rejects.toMatchObject({ code: "NOT_DIRECTORY" });
  });
  it("uses batched git ignore rules including nested negations and newline filenames", async () => {
    const { service, file } = await fixture({}, true);
    await file(".gitignore", "*.log\ncache/\n!keep.log\n");
    await file("hide.log", "hidden");
    await file("line\nbreak.log", "hidden");
    await file("keep.log", "visible");
    await file("cache/deep.txt", "hidden");
    await file("src/.gitignore", "*.txt\n!keep.txt\n");
    await file("src/hide.txt", "hidden");
    await file("src/keep.txt", "visible");
    expect((await service.list({ dir: "", depth: 5 })).entries.map((entry) => entry.path)).toEqual([
      ".gitignore",
      "keep.log",
      "src",
      "src/.gitignore",
      "src/keep.txt",
    ]);
    const all = (await service.list({ dir: "", depth: 5, includeIgnored: true })).entries;
    expect(all.find((entry) => entry.path === "cache/deep.txt")).toMatchObject({
      type: "file",
      ignored: true,
      size: 6,
    });
    expect(all.find((entry) => entry.path === "keep.log")).toMatchObject({ ignored: false });
    expect(all.some((entry) => entry.path.startsWith(".git/"))).toBe(false);
  });
  it("keeps tracked files visible when their names match an ignore pattern", async () => {
    const { service, root, file } = await fixture({}, true);
    await file(".gitignore", "*.log\n");
    await file("tracked.log", "tracked");
    await file("untracked.log", "hidden");
    await exec("git", ["-C", root, "add", "-f", "tracked.log"]);
    expect(
      (await service.list({ dir: "" })).entries.map((entry) => [entry.path, entry.ignored]),
    ).toEqual([
      [".gitignore", false],
      ["tracked.log", false],
    ]);
  });
  it("applies no ignore rules outside a git repository", async () => {
    const { service, file } = await fixture();
    await file(".gitignore", "*.log\n");
    await file("visible.log", "hello");
    expect(
      (await service.list({ dir: "" })).entries.find((entry) => entry.path === "visible.log"),
    ).toMatchObject({ ignored: false, size: 5 });
  });
  it("lists relative metadata at the requested depth and pages without duplicates", async () => {
    const { service, file } = await fixture();
    await file("src/deep/a.ts", "abc");
    await file("src/b.ts", "defg");
    await file("z.ts", "z");
    expect((await service.list({ dir: "src" })).entries.map((entry) => entry.path)).toEqual([
      "src/b.ts",
      "src/deep",
    ]);
    const first = await service.list({ dir: "", depth: 5, limit: 2 });
    const second = await service.list({
      dir: "",
      depth: 5,
      limit: 2,
      cursor: cursor(first.nextCursor),
    });
    const third = await service.list({
      dir: "",
      depth: 5,
      limit: 2,
      cursor: cursor(second.nextCursor),
    });
    expect(
      [...first.entries, ...second.entries, ...third.entries].map((entry) => entry.path),
    ).toEqual(["src", "src/b.ts", "src/deep", "src/deep/a.ts", "z.ts"]);
    expect(third).toMatchObject({ truncated: false, nextCursor: null });
    expect(second.entries.find((entry) => entry.path === "src/deep/a.ts")).toMatchObject({
      type: "file",
      size: 3,
      mtime: expect.any(Number),
    });
    await expect(
      service.list({ dir: "src", cursor: cursor(first.nextCursor) }),
    ).rejects.toMatchObject({
      code: "INVALID_CURSOR",
    });
    await expect(service.list({ dir: "", cursor: "junk" })).rejects.toMatchObject({
      code: "INVALID_CURSOR",
    });
  });
  it("returns metadata without bytes for NUL content in the first 8 KiB even at a later offset", async () => {
    const { service, file } = await fixture();
    await file(
      "binary",
      Buffer.concat([Buffer.alloc(8191, 65), Buffer.from([0]), Buffer.from("text after")]),
    );
    const content = await service.read({ path: "binary", offset: 8192, length: 10 });
    expect(content).toMatchObject({ binary: true, bytesRead: 0, size: 8202 });
    expect(content).not.toHaveProperty("text");
    await file("late-nul", Buffer.concat([Buffer.alloc(8192, 65), Buffer.from([0])]));
    expect(await service.read({ path: "late-nul", length: 1 })).toMatchObject({
      binary: false,
      text: "A",
    });
  });
  it("caps a large-file read at one MiB and supports byte offsets and EOF", async () => {
    const { service, file } = await fixture();
    await file("large", "0123456789".repeat(250_000));
    const content = await service.read({ path: "large", length: 2_500_000 });
    expect(content).toMatchObject({ binary: false, bytesRead: 1024 * 1024, truncated: true });
    if (!content.binary) expect(Buffer.byteLength(content.text)).toBe(1024 * 1024);
    expect(await service.read({ path: "large", offset: 17, length: 4 })).toMatchObject({
      text: "7890",
      bytesRead: 4,
    });
    expect(await service.read({ path: "large", offset: 2_499_998 })).toMatchObject({
      text: "89",
      truncated: false,
    });
    expect(await service.read({ path: "large", offset: 3_000_000 })).toMatchObject({
      text: "",
      bytesRead: 0,
      truncated: false,
    });
    await expect(service.read({ path: "large", offset: -1 })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });
  it("decodes UTF-8 text and marks invalid byte sequences as lossy", async () => {
    const { service, file } = await fixture();
    await file("unicode", "café 🐈");
    await file("invalid", Buffer.from([0x61, 0xff, 0x62]));
    expect(await service.read({ path: "unicode" })).toMatchObject({
      text: "café 🐈",
      encoding: "utf-8",
    });
    expect(await service.read({ path: "invalid" })).toMatchObject({
      text: "a�b",
      encoding: "utf-8-lossy",
    });
  });
});
