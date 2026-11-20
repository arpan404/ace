import { mkdtemp, realpath, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { GitWorkspace } from "./index.ts";

test("standalone folders resolve and read files without initializing Git", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-chat-context-")));
  try {
    await mkdir(join(root, "notes"));
    await writeFile(join(root, "notes/example.txt"), "hello chat");
    await symlink(join(root, "notes"), join(root, "link"), "dir");
    const workspace = new GitWorkspace(root);
    expect(await workspace.inspect("notes/example.txt")).toBe("file");
    expect((await workspace.read("notes/example.txt", 100)).bytes.toString()).toBe("hello chat");
    await expect(workspace.read("link/example.txt", 100)).rejects.toMatchObject({
      code: "outside_workspace",
    });
    await expect(workspace.read("../escape", 100)).rejects.toMatchObject({
      code: "outside_workspace",
    });
    await rm(join(root, "notes"), { recursive: true });
    await expect(workspace.inspect("notes/example.txt")).rejects.toMatchObject({
      code: "not_found",
    });
    await writeFile(join(root, "plain.txt"), "still here");
    await writeFile(join(root, ".git"), "broken repository metadata");
    await expect(new GitWorkspace(root).inspect("plain.txt")).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("invalid gitfile format"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
