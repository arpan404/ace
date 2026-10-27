import type { ClientCore, ThreadSource } from "@ace/client";
import {
  InteractionId,
  ThreadId,
  type AppState,
  type Notification,
  type NotificationFeed,
  type NotificationPreferences,
} from "@ace/protocol";
import { createHostLedgers, type LedgerPersistence } from "./notification-ledger.ts";
import {
  encodeKeySegment,
  notificationCommandId,
  notificationRequestId,
} from "./notification-routing.ts";

/**
 * Daemon notification sync for one paired machine (parity slices A14.01–A14.03).
 *
 * Mirrors the iOS `NotificationBridge` (`apps/ios/bridge/notifications.ts`)
 * without copying it: alerts come only from the daemon's canonical
 * `notification` frames and its catch-up feed — nothing here derives an alert
 * from thread status. The caller owns prompting, posting and navigation; this
 * module owns the wire contract against the real SDK `Client`:
 *
 * - register `phone/websocket` once per connection while enabled, unregister
 *   once per connection while muted/off (a mute that could not be sent is
 *   applied on the next connection);
 * - report `presence.update` app state so a backgrounded socket is not
 *   counted as delivered;
 * - catch up per the persisted ledger cursor (withdraw retracted ids, admit
 *   each entry once via the device + host ledger, follow the daemon head
 *   including a rebuilt database that moved it backwards);
 * - answer Allow/Deny only for the exact pending approval option, through the
 *   durable outbox, after reading confirmed thread state.
 *
 * One bridge per `Client`: a `Client` serves one paired machine, and two
 * bridges sharing one client would race register/unregister on the same
 * connection. Every paired machine gets its own client and its own bridge
 * (mirroring iOS one `NotificationBridge` per `ClientModel`).
 *
 * No fake production connection: every method below runs against the passed
 * client, and tests drive it through the real SDK plus the in-process fake
 * daemon (`@ace/fake-daemon`), the same seam the iOS bridge tests use.
 *
 * Limits: retracted ids stay in the shown set until the 512-id bound evicts
 * them, so a re-pushed id after a retract stays suppressed (same as iOS);
 * concurrent taps on one interaction take the first tap's option and replay
 * its outcome; without `hostId` there is no ledger (legacy single-machine
 * callers) and nothing dedupes or persists.
 */

export type NotificationActionOutcome =
  | "stale"
  | "unreachable"
  | "unsaved"
  | "saved"
  | "confirmed"
  | "refused";

export type NotificationSink =
  | { type: "notifications.connected" }
  | { type: "notifications.alert"; notification: Notification }
  | { type: "notifications.feed"; cursor: number; entries: Notification[]; retracted: string[] }
  | { type: "notifications.config"; preferences: unknown }
  | { type: "notifications.action"; id: string; outcome: NotificationActionOutcome };

export type NotificationClient = Pick<
  ClientCore,
  | "state"
  | "connectionState"
  | "onMessage"
  | "request"
  | "send"
  | "thread"
  | "enqueue"
  | "intent"
  | "commandId"
>;

type Put = (key: string, read: () => NotificationSink | undefined) => void;
type Schedule = (delayMs: number, run: () => void) => () => void;

export interface NotificationSyncOptions {
  detailsMs?: number | undefined;
  receiptMs?: number | undefined;
  schedule?: Schedule | undefined;
  /**
   * The paired machine this bridge serves. Required for ledger dedupe and
   * persistence; all patch keys are namespaced by it, so two machines sharing
   * one patch store never collide. Omit only for legacy single-machine
   * callers and tests (no dedupe, no persistence).
   */
  hostId?: string | undefined;
  /**
   * This phone's device id. Scopes the ledger by device + host (mirroring iOS
   * `LedgerStore` scope `SHA256(hostId + "\0" + deviceId)`): the same daemon
   * alert id after a device rotation is another notification. Omit only for
   * legacy single-device callers; without it the scope is the bare host id.
   */
  deviceId?: string | undefined;
  /**
   * Where the device + host ledger snapshots live across restarts. Injected;
   * the default is memory (no durability). Production passes Keystore/SQLite
   * storage scoped by `namespaceFor`.
   */
  persistence?: LedgerPersistence | undefined;
}

const defaultSchedule: Schedule = (delayMs, run) => {
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
};

export function createNotificationSync(
  client: NotificationClient,
  put: Put,
  options: NotificationSyncOptions = {},
): {
  sync(input: { enabled: boolean; appState: AppState; cursor: number }): void;
  cursor(): number;
  connected(): void;
  resolve(input: {
    requestId: string;
    threadId: string;
    interactionId: string;
    optionId: string;
    alert: Notification;
    canOperate: boolean;
  }): Promise<NotificationActionOutcome>;
  snooze(threadId: string, until: number): void;
  savePreferences(preferences: NotificationPreferences): void;
  loadConfig(): void;
  close(): void;
} {
  const detailsMs = options.detailsMs ?? 8000;
  const receiptMs = options.receiptMs ?? 15000;
  const schedule = options.schedule ?? defaultSchedule;
  const hostId = options.hostId;
  const ledgers = createHostLedgers(
    hostId === undefined && options.deviceId === undefined && options.persistence === undefined
      ? undefined
      : { deviceId: options.deviceId, persistence: options.persistence },
  );
  const encodedHost = hostId === undefined ? undefined : encodeKeySegment(hostId);
  const keyPrefix = encodedHost === undefined ? "notifications" : `notifications:${encodedHost}`;
  const alertKey = (id: string): string =>
    `notifications:alert:${notificationRequestId(id, hostId)}`;
  const feedKey = `${keyPrefix}:feed`;
  const connectedKey = `${keyPrefix}:connected`;
  const configKey = `${keyPrefix}:config`;
  const actionKey = (requestId: string): string =>
    `${keyPrefix}:action:${encodeKeySegment(requestId)}`;
  let enabled = false;
  let appState: AppState = "foreground";
  let cursor = 0;
  let synced = false;
  let daemon: "registered" | "unregistered" | undefined;
  let connection = 0;
  let queue: Promise<void> = Promise.resolve();
  /** One in-flight answer per interaction: concurrent taps share it, never double-enqueue. */
  const resolving = new Map<string, Promise<NotificationActionOutcome>>();
  const stops: (() => void)[] = [];
  let closed = false;

  const connectionView = client.connectionState();
  stops.push(
    // The SDK selection notifies on every connection change; only `ready`
    // may register and catch up, anything else resets the per-connection mark.
    connectionView.subscribe(() => {
      if (closed) return;
      if (connectionView.getSnapshot() === "ready") void onConnected();
      else {
        connection += 1;
        daemon = undefined;
      }
    }),
    client.onMessage((message) => {
      if (message.type === "notification" && enabled && !closed) {
        // Live frames admit through the ledger; the catch-up feed replays the
        // same ids and must not post them twice.
        if (hostId !== undefined && !ledgers.admit(hostId, message.notification.id)) return;
        put(alertKey(message.notification.id), () => ({
          type: "notifications.alert",
          notification: message.notification,
        }));
      }
    }),
  );

  function sync(input: { enabled: boolean; appState: AppState; cursor: number }): void {
    const changed = input.appState !== appState || input.enabled !== enabled;
    enabled = input.enabled;
    synced = true;
    appState = input.appState;
    if (hostId === undefined) {
      cursor = Math.max(cursor, input.cursor);
    } else {
      // Seed forward-only from the caller's restored cursor. Rewinds only
      // ever come from the daemon head in catchUp (a rebuilt database), never
      // from a stale caller snapshot.
      if (input.cursor > ledgers.cursor(hostId)) ledgers.advance(hostId, input.cursor);
      cursor = Math.max(cursor, ledgers.cursor(hostId));
    }
    if (client.state === "ready") {
      if (changed) presence();
      void follow();
    }
  }

  function readCursor(): number {
    return hostId === undefined ? cursor : Math.max(cursor, ledgers.cursor(hostId));
  }

  function connected(): void {
    void onConnected();
  }

  async function onConnected(): Promise<void> {
    presence();
    put(connectedKey, () => ({ type: "notifications.connected" }));
    await follow();
  }

  function follow(): Promise<void> {
    queue = queue.then(() => reconcile());
    return queue;
  }

  async function reconcile(): Promise<void> {
    if (closed || !synced || client.state !== "ready") return;
    const want = enabled ? "registered" : "unregistered";
    if (daemon !== want) {
      const atEntry = connection;
      try {
        if (want === "registered")
          await client.request({
            type: "notification.register",
            device: { channel: "websocket", platform: "phone" },
          });
        else await client.request({ type: "notification.unregister" });
      } catch {
        return; // The next connection retries; catch-up needs a registered device.
      }
      if (atEntry !== connection || closed) return;
      daemon = want;
    }
    if (want === "registered") await catchUp();
  }

  function presence(): void {
    try {
      client.send({ type: "presence.update", threadId: null, inputAgeMs: 0, appState });
    } catch {
      // Offline: the next connection sends current presence and catches up.
    }
  }

  async function catchUp(): Promise<void> {
    let feed: NotificationFeed;
    try {
      const result = await client.request({ type: "notification.feed", afterCursor: readCursor() });
      if (result.type !== "notification.feed.result") return;
      feed = { cursor: result.cursor, entries: result.entries, retracted: result.retracted };
    } catch {
      return;
    }
    let entries = feed.entries;
    if (hostId !== undefined) {
      // Admit before advancing: ids shown before a rebuild stay deduped while
      // the cursor follows the daemon head backwards (mirrors iOS
      // `LocalNotifier.catchUp`).
      entries = feed.entries.filter((entry) => ledgers.admit(hostId, entry.notification.id));
      ledgers.advance(hostId, feed.cursor);
    }
    // Follow the daemon head, including a rebuilt database that moved it
    // backwards; the ledger dedupes reissued ids.
    cursor = feed.cursor;
    put(feedKey, () => ({
      type: "notifications.feed",
      cursor: feed.cursor,
      entries: entries.map((entry) => entry.notification),
      retracted: feed.retracted,
    }));
  }

  function confirmed(store: ThreadSource): Promise<boolean> {
    const state = (): boolean | undefined =>
      store.error ? false : store.thread && !store.syncing && !store.unconfirmed ? true : undefined;
    const now = state();
    if (now !== undefined) return Promise.resolve(now);
    return new Promise((settleConfirmed) => {
      let done = false;
      const finish = (value: boolean): void => {
        if (done) return;
        done = true;
        stop();
        cancel();
        settleConfirmed(value);
      };
      const stop = store.observe(() => {
        const value = state();
        if (value !== undefined) finish(value);
      });
      const cancel = schedule(detailsMs, () => finish(false));
    });
  }

  async function resolve(input: {
    requestId: string;
    threadId: string;
    interactionId: string;
    optionId: string;
    alert: Notification;
    canOperate: boolean;
  }): Promise<NotificationActionOutcome> {
    const outcome = (value: NotificationActionOutcome): NotificationActionOutcome => {
      put(actionKey(input.requestId), () => ({
        type: "notifications.action",
        id: input.requestId,
        outcome: value,
      }));
      return value;
    };
    if (!input.canOperate) return outcome("refused");
    const parsedThread = ThreadId.safeParse(input.threadId);
    const parsedInteraction = InteractionId.safeParse(input.interactionId);
    if (!parsedThread.success || !parsedInteraction.success) return outcome("stale");
    // Concurrent taps on one interaction share a single answer: the first
    // tap's exact live option wins, every tap reports under its own UI
    // request id, and the outbox sees exactly one command.
    const shared = resolving.get(parsedInteraction.data);
    if (shared !== undefined) return outcome(await shared);
    const task = settleAction(parsedThread.data, parsedInteraction.data, input.optionId, () =>
      outcome("saved"),
    );
    resolving.set(parsedInteraction.data, task);
    try {
      return outcome(await task);
    } catch {
      return outcome("unsaved");
    } finally {
      if (resolving.get(parsedInteraction.data) === task) resolving.delete(parsedInteraction.data);
    }
  }

  async function settleAction(
    threadId: string,
    interactionId: InteractionId,
    optionId: string,
    saved: () => void,
  ): Promise<NotificationActionOutcome> {
    const lease = client.thread(threadId);
    try {
      if (!(await confirmed(lease.store))) return "unreachable";
      const interaction = lease.store.interaction(interactionId);
      const pending =
        interaction?.state === "pending" && interaction.request.kind === "approval"
          ? interaction.request.options.find((option) => option.id === optionId)
          : undefined;
      // The button must name exactly what the daemon offers now; a resolved,
      // revoked or mismatched interaction sends nothing. The payload carries
      // the confirmed live option id, never the stale alert's option.
      if (!pending) return "stale";
      const payload = {
        type: "interaction.resolve" as const,
        interactionId,
        resolution: { kind: "approval" as const, optionId: pending.id },
      };
      // Stable per (interaction, option): a duplicate tap replays the same
      // outbox command instead of double-answering, even under its own UI
      // request id. Unambiguous for arbitrary valid ids.
      const commandId = notificationCommandId(interactionId, pending.id);
      try {
        await client.enqueue(payload, commandId);
      } catch {
        return "unsaved";
      }
      saved();
      return await waitReceipt(commandId);
    } finally {
      lease.release();
    }
  }

  async function waitReceipt(commandId: string): Promise<NotificationActionOutcome> {
    const selection = client.intent(commandId);
    const terminal = (): boolean | undefined => {
      const snapshot = selection.getSnapshot();
      if (!snapshot?.result) return undefined;
      return snapshot.result.ok;
    };
    const first = terminal();
    if (first !== undefined) return first ? "confirmed" : "refused";
    const settled = await new Promise<boolean | undefined>((settleReceipt) => {
      let done = false;
      const finish = (value: boolean | undefined): void => {
        if (done) return;
        done = true;
        stop();
        cancel();
        settleReceipt(value);
      };
      const stop = selection.subscribe(() => {
        const value = terminal();
        if (value !== undefined) finish(value);
      });
      const cancel = schedule(receiptMs, () => finish(undefined));
    });
    if (settled === undefined) return "saved";
    return settled ? "confirmed" : "refused";
  }

  function snooze(threadId: string, until: number): void {
    const parsed = ThreadId.safeParse(threadId);
    if (!parsed.success) return;
    try {
      client.send({ type: "notification.snooze", threadId: parsed.data, until });
    } catch {
      // Offline: the daemon applies snooze on the next connection's register.
    }
  }

  function savePreferences(preferences: NotificationPreferences): void {
    try {
      client.send({ type: "notification.preferences", preferences });
    } catch {
      // Offline: the next connection re-syncs and reloads config.
    }
    void loadConfig();
  }

  function loadConfig(): void {
    client
      .request({ type: "notification.config" })
      .then((result) => {
        if (result.type !== "notification.config.result" || closed) return;
        put(configKey, () => ({
          type: "notifications.config",
          preferences: result.preferences,
        }));
      })
      .catch(() => {
        // Settings keep their last known values.
      });
  }

  function close(): void {
    closed = true;
    resolving.clear();
    for (const stop of stops.splice(0)) stop();
  }

  return {
    sync,
    cursor: readCursor,
    connected,
    resolve,
    snooze,
    savePreferences,
    loadConfig,
    close,
  };
}
