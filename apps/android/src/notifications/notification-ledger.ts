/**
 * Per-host notification ledger (parity slice A14.01).
 *
 * Ports iOS `NotificationLedger` (`Sources/Notifications/NotificationLedger.swift`):
 * the same alert arrives live and again from catch-up, so each id is admitted
 * once; the daemon cursor only moves forward per host and a rebuilt database
 * (cursor beyond the high-water mark) restarts from its head. Bounded to the
 * newest 512 ids so a long-lived phone cannot grow without limit.
 */

export const NOTIFICATION_LEDGER_CAPACITY = 512;

export interface NotificationLedgerSnapshot {
  cursor: number;
  shown: readonly string[];
}

export function createNotificationLedger(
  initial: NotificationLedgerSnapshot = { cursor: 0, shown: [] },
): {
  readonly cursor: number;
  readonly shown: readonly string[];
  admit(id: string): boolean;
  advance(cursor: number): void;
  snapshot(): NotificationLedgerSnapshot;
} {
  let cursor = Math.max(0, Math.floor(initial.cursor));
  let shown = [...initial.shown];
  return {
    get cursor() {
      return cursor;
    },
    get shown() {
      return [...shown];
    },
    admit(id: string): boolean {
      if (shown.includes(id)) return false;
      shown.push(id);
      if (shown.length > NOTIFICATION_LEDGER_CAPACITY)
        shown.splice(0, shown.length - NOTIFICATION_LEDGER_CAPACITY);
      return true;
    },
    advance(next: number): void {
      cursor = Math.max(0, Math.floor(next));
    },
    snapshot(): NotificationLedgerSnapshot {
      return { cursor, shown: [...shown] };
    },
  };
}

export type LedgerPersistence = {
  load(hostId: string): NotificationLedgerSnapshot | null;
  save(hostId: string, snapshot: NotificationLedgerSnapshot): void;
};

/**
 * One ledger per paired machine. The host id namespaces both the cursor and
 * the shown ids, so the same daemon alert id from two machines is two
 * notifications (ADR 0087). Persistence is injected; the default is memory.
 */
export function createHostLedgers(persistence?: LedgerPersistence | undefined): {
  admit(hostId: string, id: string): boolean;
  advance(hostId: string, cursor: number): void;
  cursor(hostId: string): number;
  snapshot(hostId: string): NotificationLedgerSnapshot;
} {
  const ledgers = new Map<string, ReturnType<typeof createNotificationLedger>>();
  const load = (hostId: string): ReturnType<typeof createNotificationLedger> => {
    const existing = ledgers.get(hostId);
    if (existing) return existing;
    const created = createNotificationLedger(persistence?.load(hostId) ?? undefined);
    ledgers.set(hostId, created);
    return created;
  };
  const persist = (hostId: string): void => {
    const ledger = ledgers.get(hostId);
    if (ledger) persistence?.save(hostId, ledger.snapshot());
  };
  return {
    admit(hostId, id) {
      const admitted = load(hostId).admit(id);
      if (admitted) persist(hostId);
      return admitted;
    },
    advance(hostId, cursor) {
      load(hostId).advance(cursor);
      persist(hostId);
    },
    cursor(hostId) {
      return load(hostId).cursor;
    },
    snapshot(hostId) {
      return load(hostId).snapshot();
    },
  };
}
