/**
 * Moves a drag may have in flight at once. The transport and the daemon's per-device queue keep
 * them in order, so a drag advances at the pointer's rate instead of once per round trip; past
 * this many, only the newest move waits (a stalled link never builds a backlog of stale motion).
 */
export const pointerMovesInFlight = 6;

/** Up to `limit` moves in flight and one replaceable move. End events discard stale motion. */
export function coalescedPointerMoves<T>(
  send: (value: T) => Promise<void>,
  error: (error: unknown) => void,
  limit = pointerMovesInFlight,
) {
  let pending: T | undefined;
  let inFlight = 0;
  let active = true;
  const sending = new Set<Promise<void>>();
  const deliver = (value: T) => {
    inFlight++;
    const sent: Promise<void> = send(value)
      .catch(error)
      .finally(() => {
        inFlight--;
        sending.delete(sent);
        const next = pending;
        pending = undefined;
        if (active && next !== undefined) deliver(next);
      });
    sending.add(sent);
  };
  const settle = async (): Promise<void> => {
    while (sending.size) await Promise.all(sending);
  };
  return {
    move(value: T) {
      if (!active) return;
      if (inFlight >= limit) pending = value;
      else deliver(value);
    },
    settle,
    discard() {
      pending = undefined;
    },
    close() {
      active = false;
      pending = undefined;
    },
  };
}
