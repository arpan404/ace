import { z } from "zod";
import { DaemonTarget } from "./connection-settings.ts";

/** What a tab hands the client worker: the daemon to reach and this device's identity. */
export const WorkerTarget = DaemonTarget.extend({
  deviceId: z.string().min(1),
  /** The outbox an older build kept in localStorage, to carry over once. */
  seed: z.string().nullable(),
});
export type WorkerTarget = z.infer<typeof WorkerTarget>;

/** One client per daemon and device; the token is not part of it. */
export const outboxKey = (target: { url: string; deviceId: string }) =>
  `ace.outbox.${target.url}.${target.deviceId}`;
