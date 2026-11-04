import { z } from "zod";

/*
 * Updating a machine from any client (ADR 0113). Each machine reports one status: what it runs,
 * what kind of install it is, the release on offer for its platform and how far an update has
 * got. An administrator asks it to update when idle or now. Everything here is decoded
 * leniently: a newer daemon's states, reasons and fields are kept as they are, never refused.
 */

const version = z.string().min(1).max(80);
const timestamp = z.number().int().nonnegative();
/** A newer daemon's own value, kept as written beside the known ones. */
const other = z.string().min(1).max(64);

/**
 * How ace is installed there. `desktop`: the desktop app with its bundled daemon. `standalone`:
 * install.sh / install.ps1 under the service manager. `source`: a checkout, updated with git.
 */
export const MachineInstall = z.union([z.enum(["desktop", "standalone", "source"]), other]);
export type MachineInstall = z.infer<typeof MachineInstall>;

/**
 * How far the machine's update has got. `none`: up to date or nothing found yet. `available`:
 * a newer release is on offer. `waiting`: asked to update when idle, waiting for agents to
 * finish. `downloading`, `ready` (downloaded), `installing` (stopping and restarting).
 * `updated`: the last update finished. `failed`: it didn't; the old version still runs and
 * `error` says why.
 */
export const MachineUpdateState = z.union([
  z.enum([
    "none",
    "available",
    "waiting",
    "downloading",
    "ready",
    "installing",
    "updated",
    "failed",
  ]),
  other,
]);
export type MachineUpdateState = z.infer<typeof MachineUpdateState>;

/**
 * Why a client can't start the update from elsewhere, when it can't. `release-page`: this
 * install doesn't replace itself (a deb or tar.gz, an ad-hoc signed Mac app); the release page
 * has the new package. `app-closed`: a desktop install whose app isn't running. `source`: a
 * checkout. `unknown`: the machine hasn't been able to check yet.
 */
export const MachineUpdateBlock = z.union([
  z.enum(["release-page", "app-closed", "source", "unknown"]),
  other,
]);
export type MachineUpdateBlock = z.infer<typeof MachineUpdateBlock>;

export const MachineUpdateMode = z.union([z.enum(["idle", "now"]), other]);
export type MachineUpdateMode = z.infer<typeof MachineUpdateMode>;

/** An administrator's request the machine holds until it has been carried out or replaced. */
export const MachineUpdateAsk = z.looseObject({
  id: z.string().min(1).max(128),
  mode: MachineUpdateMode,
  /** The release the person saw and asked for. */
  version,
  requestedAt: timestamp,
});
export type MachineUpdateAsk = z.infer<typeof MachineUpdateAsk>;

/** How the last update ended, kept across the restart it caused. */
export const MachineUpdateOutcome = z.looseObject({
  from: version,
  to: version,
  ok: z.boolean(),
  error: z.string().max(2000).nullable(),
  at: timestamp,
});
export type MachineUpdateOutcome = z.infer<typeof MachineUpdateOutcome>;

export const MachineUpdate = z.looseObject({
  /** The running version. */
  version,
  /** `process.platform` and `process.arch`, as the daemon runs. */
  platform: z.string().min(1).max(32),
  arch: z.string().min(1).max(32),
  install: MachineInstall,
  state: MachineUpdateState,
  /** The release on offer for this platform; null when none is newer or none was found. */
  available: version.nullable(),
  releaseUrl: z.url().max(400).nullable(),
  /** Set when a client can't start the update here; null when it can. */
  blocked: MachineUpdateBlock.nullable(),
  /** The request being carried out, while one is. */
  ask: MachineUpdateAsk.nullable(),
  /** Threads at work or waiting on a person: an update now stops them, when idle waits. */
  busy: z.number().int().nonnegative(),
  /** Download progress, 0–100, while downloading and the installer reports it. */
  percent: z.number().min(0).max(100).nullable(),
  /** Why the update failed or can't continue, in words for the person. */
  error: z.string().max(2000).nullable(),
  last: MachineUpdateOutcome.nullable(),
  /** When the machine last asked its release feed. */
  checkedAt: timestamp.nullable(),
});
export type MachineUpdate = z.infer<typeof MachineUpdate>;

/**
 * `status` (read scope) returns the status and keeps this socket told of changes with
 * `machineUpdate.changed`. `check` asks the release feed now (admin). `start` (admin) asks the
 * machine to update to `version`: `idle` waits until no thread works or waits on a person;
 * `now` stops running agents, which continue after the restart, and needs `agents`, the number
 * of working agents the person confirmed. `cancel` (admin) withdraws a request that hasn't
 * started installing.
 */
export const MachineUpdateRequest = z.object({
  type: z.literal("machineUpdate.request"),
  requestId: z.string().min(1).max(128),
  operation: z.enum(["status", "check", "start", "cancel"]),
  mode: z.enum(["idle", "now"]).optional(),
  version: version.optional(),
  agents: z.number().int().nonnegative().optional(),
});
export type MachineUpdateRequest = z.infer<typeof MachineUpdateRequest>;

/**
 * Refusals: `forbidden` (not an administrator here), `blocked` (see `update.blocked`),
 * `stale` (the release on offer isn't `version`), `confirm` (more agents work than were
 * confirmed; `update.busy` says how many), `unavailable` (no updater on this daemon),
 * `invalid` (a start without mode or version).
 */
export const MachineUpdateResult = z.object({
  type: z.literal("machineUpdate.result"),
  requestId: z.string().min(1).max(128),
  ok: z.boolean(),
  update: MachineUpdate.optional(),
  error: z
    .union([z.enum(["forbidden", "blocked", "stale", "confirm", "unavailable", "invalid"]), other])
    .optional(),
});
export type MachineUpdateResult = z.infer<typeof MachineUpdateResult>;

export const MachineUpdateChanged = z.object({
  type: z.literal("machineUpdate.changed"),
  update: MachineUpdate,
});
export type MachineUpdateChanged = z.infer<typeof MachineUpdateChanged>;
