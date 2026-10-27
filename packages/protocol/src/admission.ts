import { z } from "zod";

/**
 * Whether a machine takes new work (ADR 0041's maintenance gate). Paused, new threads, turns
 * and messages wait; running turns, approvals and background tasks finish. The desktop tray's
 * "Pause new work" and a paired client's row both flip the same gate.
 */
export const Admission = z.object({
  paused: z.boolean(),
  /** Threads still at work. */
  busy: z.number().int().nonnegative(),
});
export type Admission = z.infer<typeof Admission>;

/**
 * `status` reads (read scope) and keeps this socket told of changes with `admission.changed`;
 * `pause` and `resume` need operate scope. Only sockets that asked are sent changes, so clients
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
