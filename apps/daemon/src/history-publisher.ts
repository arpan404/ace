import { Worker, type WorkerOptions } from "node:worker_threads";
import { z } from "zod";
import { isWorkerRuntimeMessage } from "@ace/provider-kit/idle-worker";
import type { Store } from "./store.ts";
import { ThreadId } from "@ace/protocol";

export type HistoryPublicationWorkerFactory = (url: URL, options: WorkerOptions) => Worker;

export async function publishHistory(
  store: Store,
  databasePath: string,
  archivePath: string,
  threadId: string,
  at: number,
  signal: AbortSignal,
  spawnWorker: HistoryPublicationWorkerFactory = (url, options) => new Worker(url, options),
) {
  signal.throwIfAborted();
  store.setHistoryWriting(true);
  const cancellation = new SharedArrayBuffer(4);
  const abort = () => Atomics.store(new Int32Array(cancellation), 0, 1);
  signal.addEventListener("abort", abort, { once: true });
  let worker: Worker | undefined;
  try {
    const publication = spawnWorker(new URL("./history-publish-worker.ts", import.meta.url), {
      workerData: { databasePath, archivePath, threadId, at, cancellation },
    });
    worker = publication;
    let failure: unknown;
    await new Promise<void>((resolve, reject) => {
      let replied = false;
      publication.on("message", (value: unknown) => {
        if (isWorkerRuntimeMessage(value)) return;
        const parsed = z
          .object({ ok: z.boolean(), reason: z.string().optional() })
          .safeParse(value);
        if (!parsed.success) {
          reject(new Error("Invalid history publication reply"));
          return;
        }
        const reply = parsed.data;
        replied = true;
        if (reply.ok) resolve();
        else reject(new Error(reply.reason ?? "History publication failed"));
      });
      publication.on("error", reject);
      publication.on("exit", () => {
        if (!replied) reject(new Error("History publication worker exited"));
      });
    }).catch((error: unknown) => {
      failure = error;
    });
    // The worker may commit before losing its reply. Settle it before reading the
    // durable outcome, so neither failure nor cancellation can hide that commit.
    await publication.terminate();
    worker = undefined;
    const imported = store.getThread(ThreadId.parse(threadId))?.imported;
    await store.notifyHistory();
    if (!imported) throw failure ?? new Error("History publication did not commit");
  } finally {
    signal.removeEventListener("abort", abort);
    try {
      await worker?.terminate();
    } finally {
      store.setHistoryWriting(false);
    }
  }
}
