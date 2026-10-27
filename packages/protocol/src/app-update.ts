import { z } from "zod";

/**
 * The desktop app's update status as it reports it to its own daemon (host token, loopback
 * `PUT /v1/app-update`), on every change and once each time it reaches the daemon.
 */
export const AppUpdateReport = z.object({
  /** The running app's version. */
  version: z.string().min(1).max(80),
  /** The version on offer, while one is available, downloading or downloaded; else null. */
  available: z.string().min(1).max(80).nullable(),
  downloaded: z.boolean(),
  /** Downloaded and installs when the app restarts. */
  restartRequired: z.boolean(),
  releaseUrl: z.url().max(400).nullable(),
});
export type AppUpdateReport = z.infer<typeof AppUpdateReport>;

/** What the daemon last heard; `report` is null when no desktop app has reported (headless). */
export const AppUpdate = z.object({ report: AppUpdateReport.nullable() });
export type AppUpdate = z.infer<typeof AppUpdate>;

/**
 * Reads the desktop app's update status (read scope) and keeps this socket told of later
 * changes with `appUpdate.changed`. Only sockets that asked are told, so clients that predate
 * this message never receive it. Read-only: installing stays on the computer.
 */
export const AppUpdateRequest = z.object({
  type: z.literal("appUpdate.request"),
  requestId: z.string().min(1).max(128),
});
export const AppUpdateResult = z.object({
  type: z.literal("appUpdate.result"),
  requestId: z.string().min(1).max(128),
  ok: z.boolean(),
  update: AppUpdate.optional(),
  error: z.enum(["forbidden"]).optional(),
});
export const AppUpdateChanged = z.object({
  type: z.literal("appUpdate.changed"),
  update: AppUpdate,
});
