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
