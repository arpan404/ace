import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { GitService } from "./index.ts";
import { git, put, repository, scalar, scratch } from "./test-repo.ts";

const lf = "one\ntwo\n";
const crlf = "one\r\ntwo\r\n";
const mixed = "one\r\ntwo\nthree\r\n";

/** Checkpoints `files`, overwrites them, restores, and returns what the checkout then holds. */
async function roundTrip(service: GitService, worktree: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) await put(worktree, path, content);
  const checkpoint = await service.createCheckpoint({ worktree, threadId: "bytes", label: "turn" });
  for (const path of Object.keys(files)) await put(worktree, path, "later\n");
  await service.restoreCheckpoint({ worktree, checkpoint: checkpoint.id });
  const restored: Record<string, string> = {};
  for (const path of Object.keys(files))
    restored[path] = await readFile(join(worktree, path), "utf8");
  return { checkpoint, restored };
}

const changedPaths = async (service: GitService, worktree: string) =>
  (
    await service.diff({
      worktree,
      from: { kind: "commit", ref: "HEAD" },
      to: { kind: "working-tree" },
    })
  ).entries
    .map((entry) => entry.path)
    .toSorted();

describe.runIf(process.platform === "win32")("Windows checkpoints keep file bytes", () => {
  test("under core.autocrlf=true, LF, CRLF and mixed files restore byte for byte and diffs stay normalized", async () => {
    const repo = await repository({ "keep.txt": "keep\n", "edit.txt": "base\n" });
    await git(repo, "config", "core.autocrlf", "true");
    const worktree = join(await scratch(), "crlf");
    const service = new GitService();
    try {
      await service.createWorktree({ repo, path: worktree, baseRef: "HEAD", branch: "crlf" });
      expect(await readFile(join(worktree, "keep.txt"), "utf8")).toBe("keep\r\n");
      const files = { "edit.txt": lf, "lf.txt": lf, "crlf.txt": crlf, "mixed.txt": mixed };
      const { checkpoint, restored } = await roundTrip(service, worktree, files);
      expect(restored).toEqual(files);
      expect(await readFile(join(worktree, "keep.txt"), "utf8")).toBe("keep\r\n");
      // The untouched CRLF checkout of an LF blob is no change at all.
      expect(await changedPaths(service, worktree)).toEqual([
        "crlf.txt",
        "edit.txt",
        "lf.txt",
        "mixed.txt",
      ]);
      expect(
        (
          await service.diff({
            worktree,
            from: { kind: "checkpoint", id: checkpoint.id },
            to: { kind: "working-tree" },
          })
        ).entries,
      ).toEqual([]);
      await service.deleteCheckpoints({ repo: worktree, threadId: "bytes" });
      expect(await scalar(worktree, "for-each-ref", "refs/ace/")).toBe("");
    } finally {
      await service.close();
    }
  });

  test("under core.autocrlf=input, CRLF and mixed files restore byte for byte", async () => {
    const repo = await repository({ "tracked.txt": "base\n" });
    await git(repo, "config", "core.autocrlf", "input");
    const service = new GitService();
    try {
      const files = { "tracked.txt": crlf, "crlf.txt": crlf, "mixed.txt": mixed };
      expect((await roundTrip(service, repo, files)).restored).toEqual(files);
    } finally {
      await service.close();
    }
  });

  test("core.safecrlf=true never stops a checkpoint of an LF file, which restores as LF", async () => {
    const repo = await repository({ "tracked.txt": "base\n" });
    await git(repo, "config", "core.autocrlf", "true");
    await git(repo, "config", "core.safecrlf", "true");
    const service = new GitService();
    try {
      const files = { "lf.txt": lf };
      expect((await roundTrip(service, repo, files)).restored).toEqual(files);
      expect(await changedPaths(service, repo)).toEqual(["lf.txt"]);
    } finally {
      await service.close();
    }
  });

  test("eol, text and ident attributes never rewrite restored files", async () => {
    const repo = await repository({
      ".gitattributes": "*.txt eol=crlf\n*.dat text\n*.id ident\n",
    });
    await git(repo, "config", "core.autocrlf", "false");
    await git(repo, "config", "core.eol", "crlf");
    const service = new GitService();
    try {
      const files = {
        "lf.txt": lf,
        "mixed.txt": mixed,
        "mixed.dat": mixed,
        "stamp.id": "$Id: written by hand $\n",
      };
      expect((await roundTrip(service, repo, files)).restored).toEqual(files);
    } finally {
      await service.close();
    }
  });

  test("an embedded repository's LF files restore byte for byte under core.autocrlf=true", async () => {
    const source = await repository({ "inner.txt": "inner\n" });
    const repo = await repository({ ".gitignore": "" });
    const nested = join(repo, "nested");
    await git(repo, "clone", "--", source, nested);
    for (const root of [repo, nested]) await git(root, "config", "core.autocrlf", "true");
    const service = new GitService();
    try {
      const files = { "outer.txt": lf, "nested/inner.txt": lf, "nested/new.txt": mixed };
      expect((await roundTrip(service, repo, files)).restored).toEqual(files);
    } finally {
      await service.close();
    }
  });
});
