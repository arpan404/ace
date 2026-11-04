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
  /**
   * The updater's own state (`idle`, `checking`, `available`, `downloading`, `downloaded`,
   * `installing`, `error`…), its progress and its last error, so remote updates can follow it.
   * Absent from apps that predate remote updates (ADR 0113).
   */
  state: z.string().min(1).max(40).optional(),
  percent: z.number().min(0).max(100).nullable().optional(),
  error: z.string().max(2000).nullable().optional(),
  /** False when this install can't replace itself and offers the release page instead. */
  inPlace: z.boolean().optional(),
});
export type AppUpdateReport = z.infer<typeof AppUpdateReport>;

/**
 * What the daemon last heard. `report` is null when no desktop app has reported (headless), the
 * app withdrew it on quit, or the app stopped checking in; `reportedAt` is when it last reported.
 */
export const AppUpdate = z.object({
  report: AppUpdateReport.nullable(),
  reportedAt: z.number().int().nonnegative().nullable(),
});
export type AppUpdate = z.infer<typeof AppUpdate>;

/**
 * Reads the desktop app's update status (read scope) and keeps this socket told of later
 * changes with `appUpdate.changed`. Only sockets that asked are told, so clients that predate
 * this message never receive it. Read-only: an administrator starts an update elsewhere with
 * `machineUpdate.request` (ADR 0113).
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

/**
 * What the daemon asks of its desktop app, in the reply to the app's report (ADR 0113).
 * `download`: fetch the release on offer. `install`: install it, `idle` draining running agents
 * first, `now` stopping them (they continue after the restart). The app runs each `id` once.
 */
export const AppUpdateInstruction = z.looseObject({
  id: z.string().min(1).max(128),
  action: z.union([z.enum(["download", "install"]), z.string().min(1).max(64)]),
  mode: z.union([z.enum(["idle", "now"]), z.string().min(1).max(64)]),
  version: z.string().min(1).max(80),
});
export type AppUpdateInstruction = z.infer<typeof AppUpdateInstruction>;

/** The daemon's reply to `PUT /v1/app-update`: what it holds, and anything it asks of the app. */
export const AppUpdateReply = AppUpdate.extend({
  instruction: AppUpdateInstruction.nullable().optional(),
});
export type AppUpdateReply = z.infer<typeof AppUpdateReply>;
