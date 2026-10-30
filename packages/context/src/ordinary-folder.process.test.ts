import { mkdtemp, realpath, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { WorkspaceCache } from "./index.ts";

test("standalone folders complete and resolve files without initializing Git", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-chat-context-")));
  const cache = new WorkspaceCache();
  try {
    const empty = await cache.get(root);
    expect(empty.index.complete("")).toEqual([]);
    await mkdir(join(root, "notes"));
    await writeFile(join(root, "notes/example.txt"), "hello chat");
    await symlink(join(root, "notes"), join(root, "link"), "dir");
    await empty.initialize();
    expect(empty.index.complete("link")).toEqual([]);
    await writeFile(join(root, "added.txt"), "new");
    await empty.update(["added.txt"]);
    expect(empty.index.complete("added")).toEqual(["added.txt"]);
    expect(empty.index.complete("example")).toEqual(["notes/example.txt"]);
    expect(await empty.inspect("notes/example.txt")).toBe("file");
    expect((await empty.read("notes/example.txt", 100)).bytes.toString()).toBe("hello chat");
    await expect(empty.read("link/example.txt", 100)).rejects.toMatchObject({
      code: "outside_workspace",
    });
    await expect(empty.read("../escape", 100)).rejects.toMatchObject({ code: "outside_workspace" });
    await rm(join(root, "notes"), { recursive: true });
    await empty.update(["notes"]);
    expect(empty.index.complete("example")).toEqual([]);
    await writeFile(join(root, ".git"), "broken repository metadata");
    await expect(empty.initialize()).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("invalid gitfile format"),
    });
  } finally {
    await cache.close();
    await rm(root, { recursive: true, force: true });
  }
});
