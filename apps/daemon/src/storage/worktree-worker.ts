/* eslint-disable unicorn/require-post-message-target-origin */
import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";
import { GitService, WorktreeRemovalRefused } from "@ace/git";
import { WorktreeRequest, type WorktreeReply } from "./worktree-worker-wire.ts";

const options = z
  .object({ transportProtocols: z.array(z.enum(["http", "https", "ssh", "file"])).optional() })
  .parse(workerData);
const git = new GitService(
  options.transportProtocols ? { transportProtocols: options.transportProtocols } : {},
);
let tail = Promise.resolve();
parentPort?.on("message", (input: unknown) => {
  tail = tail
    .then(async () => {
      const request = WorktreeRequest.parse(input);
      const op = request.operation;
      const check = () => {
        const flags = new Int32Array(request.cancellation);
        Atomics.store(flags, 1, 0);
        parentPort?.postMessage({ kind: "check", id: request.id });
        const waited = Atomics.wait(flags, 1, 0, 10000);
        if (waited === "timed-out" || Atomics.load(flags, 0))
          throw new WorktreeRemovalRefused("head_moved", "Worktree maintenance permission changed");
      };
      let result: z.infer<typeof WorktreeReply>["result"];
      try {
        check();
        switch (op.op) {
          case "inspect":
            result = { kind: "state", state: await git.inspectWorktreeCleanup(op.repo, op.path) };
            break;
          case "backup":
            result = { kind: "backup", head: await git.backupWorktree(op.repo, op.path, check) };
            break;
          case "remove":
            await git.cleanupWorktree(op, check);
            result = { kind: "done" };
            break;
          case "close":
            await git.close();
            result = { kind: "done" };
            break;
        }
      } catch (error) {
        result = {
          kind: "error",
          refused: error instanceof WorktreeRemovalRefused,
          code:
            error instanceof Error && "code" in error && typeof error.code === "string"
              ? error.code
              : "storage_worker_failed",
        };
      }
      parentPort?.postMessage({ id: request.id, result });
    })
    .catch(() => {
      process.exitCode = 1;
      parentPort?.close();
    });
});
