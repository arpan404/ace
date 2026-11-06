import * as z from "zod/mini";
import { WorkerTargetShape } from "./worker-target.ts";

/**
 * What a machine-pool worker (`machine-worker.ts`) is handed: one machine's address, token and
 * host id. Its client refuses a daemon that answers as another host. Apart from
 * `worker-target.ts` so the page, which only needs its type, never builds it.
 */
export const MachineTarget = z.object({
  ...WorkerTargetShape,
  hostId: z.string().check(z.minLength(1)),
  /** What the machine named about its other paths; parsed where they are dialed. */
  paths: z.optional(z.array(z.unknown())),
  /** The kind of path that won last time. */
  lastPath: z.optional(z.string()),
});
export type MachineTarget = z.infer<typeof MachineTarget>;
