import { Worker } from "node:worker_threads";
import { z } from "zod";
import { FileError } from "./types.ts";
import { workerRequest } from "./worker-rpc.ts";

export interface ExclusiveRename {
  move(source: string, destination: string): Promise<void>;
  close(): Promise<void>;
}
const Reply = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), code: z.string(), message: z.string() }),
]);
/** One lazy I/O worker and at most one syscall in flight. Never fall back to overwrite. */
export function createExclusiveRename(
  createWorker: () => Worker = () =>
    new Worker(new URL("./rename-worker.ts", import.meta.url), { execArgv: [] }),
): ExclusiveRename {
  const owner = workerRequest(createWorker);
  return {
    async move(source, destination) {
      const reply = Reply.parse(await owner.request({ source, destination }));
      if (!reply.ok) throw new FileError(reply.code, reply.message);
    },
    close: () => owner.close(),
  };
}
