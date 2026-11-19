import { createHash } from "node:crypto";
import { MachinePath, type MachineDescription } from "@ace/protocol";
import type { RemoteProfile } from "../cli/profiles.ts";
import { enrollPins } from "../machines/link-routes.ts";
import type { ParcelRows } from "./store.ts";

/**
 * One pairing exactly: its profile's device there and the credential it holds. Linking again,
 * even under the same name and profile, is another pairing. Never the token itself.
 */
export function pairingKey(profile: Pick<RemoteProfile, "deviceId" | "token">): string {
  return `${profile.deviceId}:${createHash("sha256").update(profile.token).digest("hex")}`;
}

/** Whether `profile` is the pairing saved under its id right now, credential and all. */
function stillSaved(profile: RemoteProfile, saved: readonly RemoteProfile[]): boolean {
  return saved.some(
    (entry) =>
      entry.id === profile.id &&
      entry.deviceId === profile.deviceId &&
      entry.token === profile.token,
  );
}

/**
 * Keeps what a linked machine said it serves (ADR 0182), for the pairing that asked it. `profile`
 * is the pairing the describe was sent as, never one looked up again by name afterwards; nothing is
 * kept if that pairing is no longer saved when the answer comes. A kind of key its link didn't pin
 * is enrolled once, then kept (ADR 0192).
 */
export function recordDescription(
  rows: ParcelRows,
  saved: readonly RemoteProfile[],
  profile: RemoteProfile,
  description: MachineDescription,
  now: number,
): void {
  if (!stillSaved(profile, saved)) return;
  const paths = (description.paths ?? []).flatMap((entry) => {
    const path = MachinePath.safeParse(entry);
    return path.success ? [path.data] : [];
  });
  const pairing = pairingKey(profile);
  const before = rows.pins(profile.id, pairing);
  const after = enrollPins(profile, before, paths);
  if (after.tls !== before.tls || after.relay !== before.relay)
    rows.savePins(profile.id, pairing, after, now);
  rows.savePaths(profile.id, paths, now);
}
