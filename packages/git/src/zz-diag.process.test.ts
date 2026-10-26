import { execFile } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "vitest";
import { GitService } from "./index.ts";
import { git, repository, scratch } from "./test-repo.ts";

const run = promisify(execFile);
const show = (step: string) => (error: unknown) => {
  const details = error && typeof error === "object" && "details" in error ? error.details : {};
  throw new Error(`${step}: ${String(error)} ${JSON.stringify(details)}`);
};

test.runIf(process.platform === "win32")("diag crlf", async () => {
  const repo = await repository({ "lines.txt": "one\ntwo\n", "keep.txt": "keep\n" });
  await git(repo, "config", "core.autocrlf", "true");
  const worktree = join(await scratch(), "crlf");
  const service = new GitService();
  await service
    .createWorktree({ repo, path: worktree, baseRef: "HEAD", branch: "crlf" })
    .catch(show("create"));
  await service
    .diff({ worktree, from: { kind: "commit", ref: "HEAD" }, to: { kind: "working-tree" } })
    .catch(show("diff1"));
  await writeFile(join(worktree, "lines.txt"), "one\r\nchanged\r\n");
  const checkpoint = await service
    .createCheckpoint({ worktree, threadId: "crlf", label: "turn" })
    .catch(show("checkpoint"));
  await writeFile(join(worktree, "lines.txt"), "later\r\n");
  await service.restoreCheckpoint({ worktree, checkpoint: checkpoint.id }).catch(show("restore"));
  await service.close();
});

test.runIf(process.platform === "win32")("diag clone", async () => {
  const base = await scratch();
  const source = join(base, "source");
  await mkdir(source);
  await git(source, "init", "--initial-branch=trunk");
  await writeFile(join(source, "README.md"), "x\n");
  await git(source, "add", "README.md");
  await git(
    source,
    "-c",
    "user.name=ace",
    "-c",
    "user.email=ace@localhost",
    "commit",
    "-m",
    "first",
  );
  const target = join(base, "Target Folder");
  await mkdir(target);
  // Plain Git from the volume path, outside ace, for comparison.
  const probe = join(base, "probe");
  await mkdir(probe);
  const guid = (
    await run("powershell", ["-NoProfile", "-Command", `(Get-Item '${probe}').FullName`])
  ).stdout.trim();
  console.log("probe", guid);
  const service = new GitService({ transportProtocols: ["file"] });
  const fd = openSync(target, "r");
  try {
    await service
      .clone(
        {
          parent: base,
          path: target,
          url: `file:///${source.replaceAll("\\", "/")}`,
          directoryFd: fd,
          signal: AbortSignal.timeout(20_000),
          progress: (value) => console.log("progress", value),
        },
        { validateUrl: () => undefined, protocols: ["file"] },
      )
      .catch(show("clone"));
  } finally {
    closeSync(fd);
    await service.close();
  }
});
