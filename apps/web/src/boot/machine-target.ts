import * as z from "zod/mini";
import { WorkerTarget } from "./worker-target.ts";

/**
 * What a machine-pool worker (`machine-worker.ts`) is handed: one machine's address, token and
 * host id. Its client refuses a daemon that answers as another host. Apart from
 * `worker-target.ts` so the page, which only needs its type, never builds it.
 */
export const MachineTarget = z.object({
  ...WorkerTarget.shape,
  hostId: z.string().check(z.minLength(1)),
});
export type MachineTarget = z.infer<typeof MachineTarget>;
