import { rename } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { GitService } from "./index.ts";
import { git, proxyGit, put, repository } from "./test-repo.ts";

const service = new GitService();

test.each(["* diff\n", "* diff=forced\n"])(
  "binary rename never exposes the original payload under %s",
  async (attributes) => {
    const oldPath = "old binary\n雪.bin";
    const path = "new binary\n☃.bin";
    const payload = Buffer.from("LEAK_RENAME_PAYLOAD\0private bytes\n");
    const repo = await repository({ ".gitattributes": attributes, [oldPath]: payload });
    await git(repo, "config", "diff.forced.binary", "false");
    await rename(join(repo, oldPath), join(repo, path));
    await put(repo, "visible.txt", "visible text\n");
    const diff = await service.diff({
      worktree: repo,
      from: { kind: "commit", ref: "HEAD" },
      to: { kind: "working-tree" },
    });
    expect(diff.entries.find((entry) => entry.path === path)).toEqual({
      path,
      oldPath,
      status: "R",
      additions: 0,
      deletions: 0,
      binary: true,
    });
    expect(diff.patch).toContain("Binary files");
    expect(diff.patch).toContain("+visible text");
    expect(diff.patch).not.toContain("\0");
    expect(diff.patch).not.toContain("LEAK_RENAME_PAYLOAD");
  },
);

test.each(["extra", "mismatched"])(
  "checkpoint listing rejects %s valid commit records rather than accepting unrelated metadata",
  async (kind) => {
    const repo = await repository();
    const saved = await service.createCheckpoint({
      worktree: repo,
      threadId: "batch",
      label: "requested",
    });
    const unrelated = await service.createCheckpoint({
      worktree: repo,
      threadId: "other",
      label: "unrelated",
    });
    const binary = await proxyGit(`if (args.includes('log')) {
    const extra = spawnSync('git',['--no-pager','log','--no-color','--no-show-signature','--no-walk=unsorted','-z','--format=%H%x00%T%x00%B',${JSON.stringify(unrelated.sha)},'--']);
    const requested = spawnSync('git',args);
    process.stdout.write(${JSON.stringify(kind)}==='extra' ? Buffer.concat([requested.stdout,extra.stdout]) : extra.stdout);
    process.exit(0);
  }`);
    await expect(
      new GitService({ gitBinary: binary }).listCheckpoints({ repo, threadId: "batch" }),
    ).rejects.toMatchObject({ code: "malformed_output" });
    expect(await service.listCheckpoints({ repo, threadId: "batch" })).toEqual([saved]);
  },
);
