import type { Worker } from "node:worker_threads";
import { startWorker } from "@ace/provider-kit/worker";
import { z } from "zod";
import { FileError } from "./types.ts";
import { workerRequest } from "./worker-rpc.ts";

export interface ExclusiveRename {
  move(source: string, destination: string): Promise<void>;
  /**
   * Swap two existing names in one step. Throws `UNSUPPORTED` where the OS or filesystem has no
   * atomic exchange; leaving it out means the same.
   */
  exchange?(first: string, second: string): Promise<void>;
  close(): Promise<void>;
}
const Reply = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), code: z.string(), message: z.string() }),
]);
/** One lazy I/O worker and at most one syscall in flight. Never fall back to overwrite. */
export function createExclusiveRename(
  createWorker: () => Worker = () =>
    startWorker(new URL("./rename-worker.ts", import.meta.url), { execArgv: [] }),
): ExclusiveRename {
  const owner = workerRequest(createWorker);
  const call = async (op: "move" | "exchange", source: string, destination: string) => {
    const reply = Reply.parse(await owner.request({ op, source, destination }));
    if (!reply.ok) throw new FileError(reply.code, reply.message);
  };
  return {
    move: (source, destination) => call("move", source, destination),
    exchange: (first, second) => call("exchange", first, second),
    close: () => owner.close(),
  };
}
