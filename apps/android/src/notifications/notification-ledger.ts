/**
 * Per-host notification ledger (parity slice A14.01).
 *
 * Ports iOS `NotificationLedger` (`Sources/Notifications/NotificationLedger.swift`):
 * the same alert arrives live and again from catch-up, so each id is admitted
 * once; the daemon cursor follows the daemon head (a rebuilt database moves it
 * backwards) and a restart restores both cursor and shown ids from persistence.
 * Bounded to the newest 512 ids so a long-lived phone cannot grow without limit.
 *
 * Scope is device + host (ADR 0087, iOS `LedgerStore` scope
 * `SHA256(hostId + "\0" + deviceId)`): the same daemon alert id from two
 * machines, or the same machine on a rotated device, is another notification.
 * The JSON pair encoding is injective and NUL-free, matching Android's
 * `namespaceFor` outbox scope.
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
  load(scope: string): NotificationLedgerSnapshot | null;
  save(scope: string, snapshot: NotificationLedgerSnapshot): void;
};

/**
 * Scope key for one paired daemon and device. JSON pair encoding is injective
 * and NUL-free (an embedded NUL would truncate a SQLite comparison and alias
 * two machines onto one namespace).
 */
export function ledgerScope(hostId: string, deviceId: string): string {
  return JSON.stringify([hostId, deviceId]);
}

/**
 * One ledger per paired machine and device. The scope namespaces both the
 * cursor and the shown ids, so the same daemon alert id from two machines (or
 * after a device rotation) is another notification. Persistence is injected;
 * the default is memory. Pass `deviceId` to scope by device + host; without
 * it the scope is the bare host id (legacy single-device callers).
 */
export function createHostLedgers(
  options?:
    | { deviceId?: string | undefined; persistence?: LedgerPersistence | undefined }
    | undefined,
): {
  admit(hostId: string, id: string): boolean;
  advance(hostId: string, cursor: number): void;
  cursor(hostId: string): number;
  snapshot(hostId: string): NotificationLedgerSnapshot;
} {
  const deviceId = options?.deviceId;
  const persistence = options?.persistence;
  const ledgers = new Map<string, ReturnType<typeof createNotificationLedger>>();
  const scopeOf = (hostId: string): string =>
    deviceId === undefined ? hostId : ledgerScope(hostId, deviceId);
  const load = (hostId: string): ReturnType<typeof createNotificationLedger> => {
    const scope = scopeOf(hostId);
    const existing = ledgers.get(scope);
    if (existing) return existing;
    const created = createNotificationLedger(persistence?.load(scope) ?? undefined);
    ledgers.set(scope, created);
    return created;
  };
  const persist = (hostId: string): void => {
    const scope = scopeOf(hostId);
    const ledger = ledgers.get(scope);
    if (ledger) persistence?.save(scope, ledger.snapshot());
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
