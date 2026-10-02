import { Worker } from "node:worker_threads";
import { z } from "zod";
import { workerRequest } from "./worker-rpc.ts";
import { FileError } from "./types.ts";

export const BlobExport = z.object({
  database: z.string().min(1).max(16384),
  temporary: z.string().min(1).max(16384),
  rowid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  size: z.number().int().nonnegative().max(2147483647),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const Reply = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), code: z.string() }),
]);
/** Export one immutable SQLite blob without ever selecting its complete bytes into Node. */
export function createBlobExport(
  createWorker: () => Worker = () =>
    new Worker(new URL("./blob-worker.ts", import.meta.url), { execArgv: [] }),
) {
  const owner = workerRequest(createWorker);
  return {
    async export(input: z.infer<typeof BlobExport>) {
      const reply = Reply.parse(await owner.request(BlobExport.parse(input)));
      if (!reply.ok) throw new FileError(reply.code, "Bounded blob export failed");
    },
    close: () => owner.close(),
  };
}
