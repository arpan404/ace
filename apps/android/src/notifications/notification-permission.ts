/**
 * Notification permission and per-machine mute policy (parity slice A14.02).
 *
 * Mirrors the iOS `NotificationCoordinator` rules
 * (`Sources/Notifications/NotificationCoordinator.swift`) with Android wording:
 * ask once, in context (after the first thread arrives from a paired machine,
 * never at first launch); a denied permission has a recovery path (settings);
 * muting is per machine and remembered across launches. The settings surface
 * must disclose the best-effort background limits (ADR 0087 + Android Doze).
 */

export type NotificationPermission = "unknown" | "notDetermined" | "denied" | "allowed";

/** Ask once, after the first thread arrives; never at first launch. */
export function shouldAskNotificationPermission(input: {
  hasReadyPairedMachineWithThread: boolean;
  asked: boolean;
  permission: NotificationPermission;
}): boolean {
  if (!input.hasReadyPairedMachineWithThread) return false;
  if (input.asked) return false;
  return input.permission === "notDetermined";
}

/** Whether alerts from this machine post on this phone. */
export function isDeliveringToMachine(input: {
  enabled: boolean;
  permission: NotificationPermission;
  mutedMachines: readonly string[];
  hostId: string;
}): boolean {
  if (!input.enabled) return false;
  if (input.permission !== "allowed") return false;
  return !input.mutedMachines.includes(input.hostId);
}

/** Toggle one machine's alerts; the result stays sorted for stable persistence. */
export function applyMachineMute(
  mutedMachines: readonly string[],
  hostId: string,
  enabled: boolean,
): string[] {
  const next = new Set(mutedMachines);
  if (enabled) next.delete(hostId);
  else next.add(hostId);
  return [...next].toSorted();
}

/**
 * Copy the settings surface shows beside the switches. Truthful about
 * delivery: reliable while the app is open, best effort afterwards; no
 * always-on promise across Doze, battery restriction or process death
 * (parity plan A14.04 owns the bounded background worker separately).
 */
export const NOTIFICATION_LIMITS_COPY =
  "Alerts are reliable while ace is open and best effort afterwards. " +
  "Missed alerts arrive when the app reconnects. Battery restriction, Doze and " +
  "process death can delay background catch-up; remote push is not used.";
