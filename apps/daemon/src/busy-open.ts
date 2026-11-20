/**
 * Opening a store at startup that another connection holds busy (ADR 0195). After a daemon is
 * killed, what it started can hold the database for a while: a child still writing, a process
 * the OS has not yet reaped. Its lock goes when they do, so the open is tried again with backoff
 * instead of failing the start; only a lock held past the whole schedule fails it.
 */

/** Waits between attempts: about a minute in all, on top of each attempt's own busy wait. */
export const busyOpenDelaysMs: readonly number[] = [
  250, 500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000,
];

/** SQLITE_BUSY or SQLITE_LOCKED anywhere in an error's cause chain. */
export function sqliteBusy(error: unknown): boolean {
  for (let cause = error, depth = 0; cause instanceof Error && depth < 5; depth++) {
    const code: unknown = Reflect.get(cause, "errcode");
    // node:sqlite reports extended result codes; the primary code is the low byte.
    if (typeof code === "number" && ((code & 0xff) === 5 || (code & 0xff) === 6)) return true;
    if (/^database (table )?is locked$/.test(cause.message)) return true;
    cause = cause.cause;
  }
  return false;
}

export interface BusyOpenPorts {
  sleep(delayMs: number): Promise<void>;
  /** Said once per retry, with what it waits. */
  onBusy(attempt: number, delayMs: number, error: unknown): void;
}

/** `open`, tried again after each delay while it fails busy; any other failure is thrown at once. */
export async function openWhileBusy<T>(
  open: () => T,
  ports: BusyOpenPorts,
  delaysMs: readonly number[] = busyOpenDelaysMs,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return open();
    } catch (error) {
      const delayMs = delaysMs[attempt];
      if (delayMs === undefined || !sqliteBusy(error)) throw error;
      ports.onBusy(attempt + 1, delayMs, error);
      await ports.sleep(delayMs);
    }
  }
}
