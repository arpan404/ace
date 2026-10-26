import { z } from "zod";

/*
 * Locked computer use (opt-in, macOS): whether agents may operate this Mac while it is locked.
 * `computer.lockedUse` records the person's intent; this family reports the Mac's actual state,
 * as the daemon detects it, and installs, removes or repairs the signed authorization component.
 * Status objects are loose: fields a newer daemon adds are kept. Unknown fields on the messages
 * themselves are dropped, never fatal.
 */

const id = z.string().min(1).max(128);
const reason = z.string().max(2048);

/** Off: the component isn't installed; locked input is refused, as without this feature. */
export const LockedUseOff = z.looseObject({ state: z.literal("off") });
/** An install, removal or repair is running. */
export const LockedUseInstalling = z.looseObject({ state: z.literal("installing") });
/** Installed and verified: approved turns may work while this Mac is locked. */
export const LockedUseOn = z.looseObject({ state: z.literal("on") });
/** Installed, but macOS still needs the person to approve it (an administrator prompt). */
export const LockedUseNeedsApproval = z.looseObject({ state: z.literal("needsApproval") });
/** The last install didn't finish; `reason` is shown to the person. */
export const LockedUseInstallFailed = z.looseObject({
  state: z.literal("installFailed"),
  reason,
});
/** What is installed no longer matches what ace expects (moved, replaced, re-signed). */
export const LockedUseDriftRepairNeeded = z.looseObject({
  state: z.literal("driftRepairNeeded"),
  reason,
});

/** This Mac's locked-use state, as detected by the daemon. */
export const LockedUseStatus = z.discriminatedUnion("state", [
  LockedUseOff,
  LockedUseInstalling,
  LockedUseOn,
  LockedUseNeedsApproval,
  LockedUseInstallFailed,
  LockedUseDriftRepairNeeded,
]);
export type LockedUseStatus = z.infer<typeof LockedUseStatus>;

/**
 * Orders observations of this Mac: a later observation always has a higher revision, and the
 * same revision is the same observation. Revisions restart with the daemon, so a client
 * compares them only within one connection.
 */
export const LockedUseRevision = z.number().int().nonnegative();
/** One observation of this Mac's state, in the installer's order. */
export const LockedUseObservation = z.object({
  revision: LockedUseRevision,
  status: LockedUseStatus,
});
export type LockedUseObservation = z.infer<typeof LockedUseObservation>;

/** Follow the state: a `lockedUse.status` reply, then `lockedUse.changed` pushes. */
export const LockedUseSubscribe = z.object({
  type: z.literal("lockedUse.subscribe"),
  requestId: id,
  subscriptionId: id,
});
/** Stop a subscription; replied with `lockedUse.result`. */
export const LockedUseUnsubscribe = z.object({
  type: z.literal("lockedUse.unsubscribe"),
  requestId: id,
  subscriptionId: id,
});
/** Install the authorization component. Admin only. */
export const LockedUseInstall = z.object({
  type: z.literal("lockedUse.install"),
  requestId: id,
});
/** Remove the authorization component. Admin only. */
export const LockedUseRemove = z.object({
  type: z.literal("lockedUse.remove"),
  requestId: id,
});
/** Reinstall over a drifted or failed component. Admin only. */
export const LockedUseRepair = z.object({
  type: z.literal("lockedUse.repair"),
  requestId: id,
});
export const LockedUseRequest = z.discriminatedUnion("type", [
  LockedUseSubscribe,
  LockedUseUnsubscribe,
  LockedUseInstall,
  LockedUseRemove,
  LockedUseRepair,
]);
export type LockedUseRequest = z.infer<typeof LockedUseRequest>;

/** The first snapshot for a subscription. */
export const LockedUseStatusMessage = z.object({
  type: z.literal("lockedUse.status"),
  requestId: id,
  subscriptionId: id,
  revision: LockedUseRevision,
  status: LockedUseStatus,
});
/** A later state for a subscription; its revision is always above any sent before it. */
export const LockedUseChanged = z.object({
  type: z.literal("lockedUse.changed"),
  subscriptionId: id,
  revision: LockedUseRevision,
  status: LockedUseStatus,
});

export const LockedUseErrorCode = z.enum(["forbidden", "busy", "unavailable", "failed"]);
/**
 * The reply to install, remove, repair and unsubscribe. `status` is the newest state the daemon
 * knows afterwards (never older than one already pushed), with its `revision`; a refusal
 * carries `code` and `reason`.
 */
export const LockedUseResult = z.object({
  type: z.literal("lockedUse.result"),
  requestId: id,
  ok: z.boolean(),
  revision: LockedUseRevision.optional(),
  status: LockedUseStatus.optional(),
  code: z.union([LockedUseErrorCode, z.string().max(64)]).optional(),
  reason: reason.optional(),
});
export type LockedUseResult = z.infer<typeof LockedUseResult>;

export const LockedUseServerMessage = z.discriminatedUnion("type", [
  LockedUseStatusMessage,
  LockedUseChanged,
  LockedUseResult,
]);
export type LockedUseServerMessage = z.infer<typeof LockedUseServerMessage>;
