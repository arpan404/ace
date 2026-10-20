import type { KeyValueStorage } from "@ace/ui-core";
import type { DaemonTarget } from "./connection-settings.ts";
import { outboxKey } from "./worker-target.ts";

/*
 * The host each target last verified itself as, so a reload can open the app from what this
 * device kept (read snapshots, kept lookups) before the daemon answers, then confirm it. A host
 * id is not a secret; the token never enters the key. Forgotten when the daemon refuses the
 * token or turns out to be another daemon, so the next load waits for an answer instead.
 */

const keyOf = (target: DaemonTarget, deviceId: string) =>
  `ace.knownHost.${outboxKey({ ...target, deviceId })}`;

/** The host `target` verified as last time; the desktop names its own daemon outright. */
export function knownHost(
  storage: KeyValueStorage,
  target: DaemonTarget,
  deviceId: string,
): string | undefined {
  if (target.localHostId) return target.localHostId;
  try {
    return storage.getItem(keyOf(target, deviceId)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function rememberHost(
  storage: KeyValueStorage,
  target: DaemonTarget,
  deviceId: string,
  hostId: string,
): void {
  try {
    storage.setItem(keyOf(target, deviceId), hostId);
  } catch {
    /* Storage is denied: the next load waits for the daemon, as before. */
  }
}

export function forgetKnownHost(
  storage: KeyValueStorage,
  target: DaemonTarget,
  deviceId: string,
): void {
  try {
    storage.removeItem?.(keyOf(target, deviceId));
  } catch {
    /* Nothing stored. */
  }
}
