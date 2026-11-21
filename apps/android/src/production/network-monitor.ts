/**
 * Network observation for production startup.
 *
 * Mirrors the iOS `NetworkMonitor` (`apps/ios/Sources/Host/NetworkMonitor.swift`):
 * reachability and interface changes (Wi-Fi to cellular, a VPN such as
 * Tailscale coming up) are reported to the SDK, which owns reconnect and
 * backoff. Only changes propagate: the first snapshot only establishes the
 * baseline, and identical snapshots report nothing, so an offline→online
 * transition wakes the runtimes while a steady state never spuriously does.
 *
 * No Expo imports here: callers map `expo-network` state to `NetworkSnapshot`
 * (see `ProductionRoot.tsx`) so the comparison rules test in plain Node.
 */

import { PRODUCTION_LOAD_TIMEOUT_MS, withLoadTimeout } from "./load-timeout.ts";

export interface NetworkSnapshot {
  readonly online: boolean;
  /** The active interface family (expo `NetworkStateType`), for change detection. */
  readonly iface: string;
}

export interface NetworkChange {
  readonly online: boolean;
  readonly interfaceChanged: boolean;
}

/**
 * Compare one observation against the previous baseline. Returns `null` when
 * there is nothing to propagate (first sighting or no change).
 */
export function networkChange(
  previous: NetworkSnapshot | undefined,
  next: NetworkSnapshot,
): NetworkChange | null {
  if (previous === undefined) return null;
  if (previous.online === next.online && previous.iface === next.iface) return null;
  return { online: next.online, interfaceChanged: previous.iface !== next.iface };
}

/** Expo network state shape read by the snapshot helper (no Expo import here). */
export interface ExpoNetworkStateInput {
  readonly isConnected?: boolean | undefined;
  readonly type?: unknown;
}

/**
 * Bounded initial network snapshot for production startup.
 *
 * `expo-network` `getNetworkStateAsync` has no timeout: a hung read would
 * stall phase one on an opaque opener with no Retry. Racing it against the
 * production load timeout keeps startup recoverable: a hang (or rejection,
 * or sync throw) falls back to `undefined`, which only establishes the
 * baseline — the first sighting propagates nothing, so startup proceeds to
 * the lock instead of stalling. The late read, when it eventually settles,
 * is swallowed and changes nothing; there is no orphaned resource to close.
 */
export async function snapshotNetworkState(
  readState: () => Promise<ExpoNetworkStateInput>,
  timeoutMs: number = PRODUCTION_LOAD_TIMEOUT_MS,
): Promise<NetworkSnapshot | undefined> {
  try {
    const state = await withLoadTimeout(Promise.resolve().then(readState), timeoutMs);
    return {
      online: state.isConnected ?? false,
      iface: typeof state.type === "string" ? state.type : "unknown",
    };
  } catch {
    return undefined;
  }
}
