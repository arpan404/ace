import { Worker } from "node:worker_threads";
import { PosixReply, type PosixOperation } from "./posix-wire.ts";

type Pending = { resolve(value: number | string | null): void; reject(error: Error): void };

/**
 * The daemon's side of the POSIX worker. The worker starts on first use and holds the process
 * open only while a call is in flight; if it dies, its pending calls fail and the next call
 * starts a fresh one. Descriptors are per process, so the fds it opens are the caller's.
 */
export class PosixWorkerClient {
  private worker: Worker | undefined;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private readonly spawn: () => Worker;
  constructor(
    spawn: () => Worker = () =>
      new Worker(new URL("./posix-worker.ts", import.meta.url), { execArgv: [] }),
  ) {
    this.spawn = spawn;
  }
  call(operation: PosixOperation): Promise<number | string | null> {
    const worker = this.start();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.ref();
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node worker RPC.
      worker.postMessage({ id, operation });
    });
  }
  private start(): Worker {
    if (this.worker) return this.worker;
    const worker = this.spawn();
    this.worker = worker;
    worker.unref();
    const fail = (error: Error) => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    };
    worker.on("error", fail);
    worker.on("exit", () => fail(new Error("Command discovery worker exited")));
    worker.on("message", (input: unknown) => {
      const reply = PosixReply.safeParse(input);
      if (!reply.success) return;
      const request = this.pending.get(reply.data.id);
      if (!request) return;
      this.pending.delete(reply.data.id);
      if (this.pending.size === 0) worker.unref();
      if (reply.data.ok) request.resolve(reply.data.value);
      else request.reject(new Error(reply.data.message));
    });
    return worker;
  }
}
