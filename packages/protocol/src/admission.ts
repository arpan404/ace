import { z } from "zod";

/**
 * What holds admission closed: the person's pause (`user`), an app update draining work
 * (`update`), kill-all's fence (`kill`) or a stop (`stop`). A client may add or remove only
 * `user`; the others end on their own.
 */
export const MaintenanceHold = z.enum(["user", "update", "kill", "stop"]);
export type MaintenanceHold = z.infer<typeof MaintenanceHold>;

/**
 * Whether a machine takes new work (ADR 0041's maintenance gate). Paused, new threads, turns
 * and messages wait; running turns, approvals and background tasks finish. The desktop tray's
 * "Pause new work" and a paired client's row both hold the same gate.
 */
export const Admission = z.object({
  /** Empty while the machine takes new work. */
  holds: z.array(MaintenanceHold).max(4),
  /** Threads still at work or waiting, `waiting` of them on a person. */
  busy: z.number().int().nonnegative(),
  waiting: z.number().int().nonnegative(),
});
export type Admission = z.infer<typeof Admission>;

/**
 * `status` reads (read scope) and keeps this socket told of changes with `admission.changed`,
 * including, while admission is closed, changes in how much work is still running. `pause` and
 * `resume` add or remove only the `user` hold and need operate scope. Only sockets that asked are sent changes, so clients
 * that predate this message never receive it.
 */
export const AdmissionRequest = z.object({
  type: z.literal("admission.request"),
  requestId: z.string().min(1).max(128),
  operation: z.enum(["status", "pause", "resume"]),
});
export type AdmissionRequest = z.infer<typeof AdmissionRequest>;

export const AdmissionResult = z.object({
  type: z.literal("admission.result"),
  requestId: z.string().min(1).max(128),
  ok: z.boolean(),
  admission: Admission.optional(),
  error: z.enum(["forbidden", "unavailable"]).optional(),
});
export type AdmissionResult = z.infer<typeof AdmissionResult>;

export const AdmissionChanged = z.object({
  type: z.literal("admission.changed"),
  admission: Admission,
});
export type AdmissionChanged = z.infer<typeof AdmissionChanged>;
