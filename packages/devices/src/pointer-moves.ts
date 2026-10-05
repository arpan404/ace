/** One pointer move in flight and one replaceable move. End events discard stale motion. */
export function coalescedPointerMoves<T>(
  send: (value: T) => Promise<void>,
  error: (error: unknown) => void,
) {
  let pending: T | undefined;
  let busy = false;
  let active = true;
  const deliver = (value: T) => {
    busy = true;
    void send(value)
      .catch(error)
      .finally(() => {
        busy = false;
        const next = pending;
        pending = undefined;
        if (active && next !== undefined) deliver(next);
      });
  };
  return {
    move(value: T) {
      if (!active) return;
      if (busy) pending = value;
      else deliver(value);
    },
    discard() {
      pending = undefined;
    },
    close() {
      active = false;
      pending = undefined;
    },
  };
}
