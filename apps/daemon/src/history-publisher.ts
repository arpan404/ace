import { Worker } from "node:worker_threads";
import { z } from "zod";
import type { Store } from "./store.ts";

export async function publishHistory(
  store: Store,
  databasePath: string,
  archivePath: string,
  threadId: string,
  at: number,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  store.setHistoryWriting(true);
  const cancellation = new SharedArrayBuffer(4);
  const abort = () => Atomics.store(new Int32Array(cancellation), 0, 1);
  signal.addEventListener("abort", abort, { once: true });
  let worker: Worker | undefined;
  try {
    const after = store.headSeq();
    const publication = new Worker(new URL("./history-publish-worker.ts", import.meta.url), {
      workerData: { databasePath, archivePath, threadId, at, cancellation },
    });
    worker = publication;
    await new Promise<void>((resolve, reject) => {
      let replied = false;
      publication.on("message", (value: unknown) => {
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
    });
    store.setHistoryWriting(false);
    await store.notifyHistory(after);
  } finally {
    signal.removeEventListener("abort", abort);
    try {
      await worker?.terminate();
    } finally {
      store.setHistoryWriting(false);
    }
  }
}
