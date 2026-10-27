import { IdleWorker, type IdleWorkerRuntime } from "@ace/provider-kit/idle-worker";
import { WorktreeRemovalRefused, type GitOptions, type WorktreeCleanupInput } from "@ace/git";
import { WorktreeCheck, WorktreeReply, type WorktreeOperation } from "./worktree-worker-wire.ts";
import type { z } from "zod";

type Result = z.infer<typeof WorktreeReply>["result"];
type Pending = { resolve(result: Result): void; reject(error: Error): void; verify(): void };

/** Filesystem walks, Git parsing, commits, pushes and removals run outside the daemon loop. */
export class WorktreeIO {
  private worker: IdleWorker;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private closed = false;
  private closing: Promise<void> | undefined;
  constructor(options: Pick<GitOptions, "transportProtocols"> = {}, runtime?: IdleWorkerRuntime) {
    this.worker = new IdleWorker(
      new URL("./worktree-worker.ts", import.meta.url),
      { workerData: options },
      runtime,
    );
    const fail = () => {
      for (const request of this.pending.values()) {
        request.reject(new Error("storage_worker_failed"));
      }
      this.pending.clear();
    };
    this.worker.on("error", fail);
    this.worker.on("exit", fail);
    this.worker.on("message", (input: unknown) => {
      const check = WorktreeCheck.safeParse(input);
      if (check.success) {
        this.pending.get(check.data.id)?.verify();
        return;
      }
      const reply = WorktreeReply.safeParse(input);
      if (!reply.success) {
        fail();
        return;
      }
      const request = this.pending.get(reply.data.id);
      if (!request) return;
      this.pending.delete(reply.data.id);
      request.resolve(reply.data.result);
      if (!this.pending.size) this.worker.idle();
    });
  }
  private async call(operation: WorktreeOperation, check = () => {}): Promise<Result> {
    if ((this.closed && operation.op !== "close") || this.pending.size >= 8)
      throw new Error("storage_busy");
    check();
    const cancellation = new SharedArrayBuffer(8);
    const verify = () => {
      const flags = new Int32Array(cancellation);
      try {
        check();
      } catch {
        Atomics.store(flags, 0, 1);
      }
      Atomics.store(flags, 1, 1);
      Atomics.notify(flags, 1);
    };
    const id = ++this.sequence;
    const result = await new Promise<Result>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, verify });
      try {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node worker RPC.
        this.worker.postMessage({ id, operation, cancellation });
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error("storage_worker_failed"));
      }
    });
    if (result.kind === "error") {
      if (result.refused)
        throw new WorktreeRemovalRefused("head_moved", "Worktree maintenance refused");
      throw Object.assign(new Error(result.code), { code: result.code });
    }
    return result;
  }
  async inspectWorktreeCleanup(repo: string, path: string) {
    const result = await this.call({ op: "inspect", repo, path });
    if (result.kind !== "state") throw new Error("storage_worker_protocol");
    return result.state;
  }
  async backupWorktree(repo: string, path: string, check = () => {}) {
    const result = await this.call({ op: "backup", repo, path }, check);
    if (result.kind !== "backup") throw new Error("storage_worker_protocol");
    return result.head;
  }
  async cleanupWorktree(input: WorktreeCleanupInput, check = () => {}) {
    await this.call({ op: "remove", ...input }, check);
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.closed = true;
      try {
        if (this.worker.started) await this.call({ op: "close" });
      } finally {
        await this.worker.terminate();
      }
    })());
  }
}
