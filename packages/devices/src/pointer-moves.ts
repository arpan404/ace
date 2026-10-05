/** One pointer move in flight and one replaceable move. End events discard stale motion. */
export function coalescedPointerMoves<T>(
  send: (value: T) => Promise<void>,
  error: (error: unknown) => void,
) {
  let pending: T | undefined;
  let busy = false;
  let active = true;
  let settled: Promise<void> = Promise.resolve();
  const deliver = (value: T) => {
    busy = true;
    settled = send(value)
      .catch(error)
      .finally(() => {
        busy = false;
        const next = pending;
        pending = undefined;
        if (active && next !== undefined) deliver(next);
      });
  };
  const settle = async (): Promise<void> => {
    const current = settled;
    await current;
    if (current !== settled) await settle();
  };
  return {
    move(value: T) {
      if (!active) return;
      if (busy) pending = value;
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
