import type { ConnectionState } from "@ace/client";

/**
 * Whether live indicators (spinners, the working glyphs) dim. Only while the daemon is
 * unreachable: nothing they stand for can arrive then. While the connection is first made or
 * the daemon starts, work is genuinely in progress and they stay at full strength.
 */
export function liveIndicatorsHeld(state: ConnectionState): boolean {
  return state === "reconnecting" || state === "offline" || state === "fatal";
}
