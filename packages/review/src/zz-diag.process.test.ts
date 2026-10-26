import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "vitest";
import { Command, ReviewExecutionTarget } from "@ace/protocol";
import { ReviewService } from "./index.ts";

const exec = promisify(execFile);
test.runIf(process.platform === "win32")("diag review open", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "ace-review-")));
  const root = join(directory, "repo");
  await mkdir(root);
  const git = async (...args: string[]) => (await exec("git", args, { cwd: root })).stdout.trim();
  await git("init", "-q");
  await git("config", "user.name", "Review test");
  await git("config", "user.email", "review@example.invalid");
  await writeFile(join(root, "file.ts"), "a\n");
  await git("add", ".");
  await git("commit", "-qm", "base");
  const base = await git("rev-parse", "HEAD");
  await writeFile(join(root, "file.ts"), "b\n");
  let counter = 0;
  const service = new ReviewService({
    path: join(directory, "review.sqlite"),
    now: () => 123,
    id: () => `id-${String(++counter).padStart(6, "0")}`,
  });
  const target = ReviewExecutionTarget.parse({
    threadId: "thread",
    workspaceId: "workspace",
    worktree: root,
  });
  const opened = await service.handle(
    Command.parse({
      id: "c1",
      deviceId: "device",
      payload: {
        type: "review.open",
        source: {
          workspaceId: "workspace",
          from: { kind: "commit", ref: base },
          to: { kind: "working-tree" },
        },
      },
    }),
    root,
    target,
  );
  const { GitService } = await import("@ace/git");
  const direct = new GitService();
  await direct
    .diff({ worktree: root, from: { kind: "commit", ref: base }, to: { kind: "working-tree" } })
    .then(
      (result) => console.log("DIFF OK", result.entries.length),
      (error: unknown) =>
        console.log(
          "DIFF FAIL",
          String(error),
          JSON.stringify((error as { details?: unknown }).details),
        ),
    );
  await direct.close();
  console.log("OPENED", JSON.stringify(opened).slice(0, 3000));
  await service.close();
});
