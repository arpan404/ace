import { randomUUID } from "node:crypto";
import { Client, webSocketTransport, type Transport } from "@ace/client";
import {
  DeviceId,
  HostId,
  NotificationMessage,
  type CommandPayload,
  type ThreadListEntry,
} from "@ace/protocol";
import { pairedSocketCredential } from "@ace/client/access-ticket";
import type { Alert } from "../notifications/router.ts";
import { alertFromDaemon } from "../notifications/router.ts";
import { derivedAlerts, WorkTally, type WorkSummary } from "./thread-watch.ts";

export interface LinkOptions {
  url: string;
  token: string;
  deviceId: string;
  pairedDeviceId?: string;
  /**
   * This computer's daemon: the identity its current home names. The link expects exactly it,
   * so a fresh start's new daemon is accepted and anything else on that port is refused.
   */
  localHostId?: string;
  /** Durable outbox for notification actions, so an Approve survives a reconnect. */
  storage: import("@ace/client").Storage;
  quietHours(): { timeZone: string; startMinute: number; endMinute: number } | null;
  onAlert(alert: Alert): void;
  onSummary(summary: WorkSummary): void;
  /**
   * The daemon's socket closed, with its close code and reason (`1001 Daemon shutdown`,
   * `4003 Device revoked` …), so the app's log says why the link dropped. Not called when the
   * app closes the link itself.
   */
  onClose?(code: number, reason: string): void;
}

/**
 * The main process's own connection to the daemon, as the "desktop" notification device. It
 * receives the daemon's notifications (the daemon delivers them over this socket first, so
 * they work with every window closed), watches the thread list for the badge, progress and
 * power-save state, reports presence and sends notification actions as durable intents.
 *
 * It only ever sends frames every daemon version understands. Optional capabilities (the
 * embedded browser backend) use their own sockets, so a daemon that rejects one can never
 * fail this link: the client treats an uncorrelated protocol error as fatal.
 */
export class DesktopLink {
  private client: Client;
  private send: ((frame: unknown) => void) | undefined;
  private presence: string | null = null;
  private entries = new Map<string, ThreadListEntry>();
  private tally = new WorkTally();
  private summary: WorkSummary | undefined;
  private stops: (() => void)[] = [];
  private options: LinkOptions;

  constructor(options: LinkOptions) {
    this.options = options;
    this.client = new Client({
      deviceId: DeviceId.parse(options.pairedDeviceId ?? options.deviceId),
      ...(options.localHostId ? { expectedHostId: HostId.parse(options.localHostId) } : {}),
      transport: () => this.transport(),
      credential: options.pairedDeviceId
        ? pairedSocketCredential({
            url: options.url,
            token: async () => options.token,
            fetch: (input, init) => fetch(input, init),
          })
        : async () => options.token,
      storage: options.storage,
      scheduler: {
        set(delayMs, callback) {
          const timer = setTimeout(callback, delayMs);
          return () => clearTimeout(timer);
        },
      },
      random: Math.random,
      id: randomUUID,
    });
  }

  async start(): Promise<void> {
    const connection = this.client.connectionState();
    this.stops.push(
      connection.subscribe(() => {
        if (connection.getSnapshot() === "ready") this.register();
      }),
    );
    await this.client.start();
    this.watchThreads();
  }

  async close(): Promise<void> {
    for (const stop of this.stops.splice(0)) stop();
    await this.client.close();
  }

  /** The machine woke up or the network came back: reconnect now. */
  wake(): void {
    this.client.networkOnline(true);
  }

  /** The client gave up for good (for example, the daemon refused its token). */
  fatal(): boolean {
    return this.client.connectionState().getSnapshot() === "fatal";
  }

  /** The thread on screen (null when none), so phones stay quiet while you watch it here. */
  setPresence(threadId: string | null): void {
    if (threadId === this.presence) return;
    this.presence = threadId;
    this.send?.({ type: "presence.update", threadId, inputAgeMs: 0 });
  }

  /** Re-send preferences after the desktop notification settings change. */
  updatePreferences(): void {
    this.send?.({
      type: "notification.preferences",
      preferences: { quietHours: this.options.quietHours(), includePreview: true },
    });
  }

  enqueue(id: string, payload: CommandPayload): Promise<string> {
    return this.client.enqueue(payload, id);
  }

  private register(): void {
    this.send?.({
      type: "notification.register",
      device: { channel: "websocket", platform: "desktop" },
    });
    this.updatePreferences();
    if (this.presence)
      this.send?.({ type: "presence.update", threadId: this.presence, inputAgeMs: 0 });
  }

  /** The client's own transport, with notification frames and closes observed on the way in. */
  private transport(): Transport {
    const inner = webSocketTransport(() => new WebSocket(this.options.url));
    this.send = (frame) => inner.send(JSON.stringify(frame));
    return {
      open: (events) =>
        inner.open({
          ...events,
          message: (data) => {
            if (data.includes('"type":"notification"')) {
              const parsed = parseNotification(data);
              if (parsed) this.options.onAlert(alertFromDaemon(parsed.notification));
            }
            events.message(data);
          },
          close: (code, reason) => {
            this.options.onClose?.(code, reason ?? "");
            events.close(code, reason);
          },
        }),
      send: (text) => inner.send(text),
      close: () => inner.close(),
    };
  }

  private watchThreads(): void {
    const { store, release } = this.client.threads();
    const threadStops = new Map<string, () => void>();
    const refresh = (id: string) => {
      const next = store.thread(id);
      const previous = this.entries.get(id);
      this.tally.set(id, next);
      if (!next) this.entries.delete(id);
      else {
        this.entries.set(id, next);
        for (const alert of derivedAlerts(previous, next)) this.options.onAlert(alert);
      }
    };
    // Badge, tray and power save hear only about a change of the counts.
    const publish = () => {
      const summary = this.tally.summary();
      if (summary === this.summary) return;
      this.summary = summary;
      this.options.onSummary(summary);
    };
    const ids = store.select(["ids"], (reader) => reader.ids);
    const sync = () => {
      const current = new Set(ids.getSnapshot());
      for (const [id, stop] of threadStops)
        if (!current.has(id)) {
          stop();
          threadStops.delete(id);
          this.entries.delete(id);
          this.tally.set(id, undefined);
        }
      for (const id of current)
        if (!threadStops.has(id)) {
          const selection = store.select([`thread:${id}`], (reader) => reader.thread(id));
          threadStops.set(
            id,
            selection.subscribe(() => {
              refresh(id);
              publish();
            }),
          );
          refresh(id);
        }
      publish();
    };
    this.stops.push(ids.subscribe(sync), () => {
      for (const stop of threadStops.values()) stop();
      release();
    });
    sync();
  }
}

function parseNotification(data: string) {
  try {
    const parsed = NotificationMessage.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
