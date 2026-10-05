import * as z from "zod/mini";
import { DaemonTarget } from "./connection-settings.ts";

/** What a tab hands the client worker: the daemon to reach and this device's identity. */
export const WorkerTarget = z.extend(DaemonTarget, {
  deviceId: z.string().check(z.minLength(1)),
  /** The outbox an older build kept in localStorage, to carry over once. */
  seed: z.nullable(z.string()),
});
export type WorkerTarget = z.infer<typeof WorkerTarget>;

/**
 * What a machine-pool worker (`machine-worker.ts`) is handed: one machine's address, token and
 * host id. Its client refuses a daemon that answers as another host.
 */
export const MachineTarget = z.extend(WorkerTarget, { hostId: z.string().check(z.minLength(1)) });
export type MachineTarget = z.infer<typeof MachineTarget>;

/** One client per daemon and device; the token is not part of it. */
export const outboxKey = (target: { url: string; deviceId: string }) =>
  `ace.outbox.${target.url}.${target.deviceId}`;
