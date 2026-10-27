import { z } from "zod";
import type { ClientCore, ThreadSource } from "@ace/client";
import {
  AppState,
  InteractionId,
  NotificationPreferences,
  ThreadId,
  type Notification,
  type NotificationFeed,
} from "@ace/protocol";
import { submitCommand } from "./commands.ts";
import {
  PhoneNotificationPrefs,
  defaultPhonePrefs,
  phoneDelivery,
  type PhoneDelivery,
} from "./notification-delivery.ts";

const boundedId = z.string().min(1).max(200);
export const NotificationAction = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("notifications.sync"),
    enabled: z.boolean(),
    appState: AppState,
    cursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    /** This phone's own delivery preferences; older hosts omit them. */
    phone: PhoneNotificationPrefs.optional(),
  }),
  z.object({ type: z.literal("notifications.config") }),
  z.object({ type: z.literal("notifications.preferences"), preferences: NotificationPreferences }),
  z.object({
    type: z.literal("notifications.snooze"),
    threadId: ThreadId.and(boundedId),
    until: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("notifications.resolve"),
    requestId: z.string().min(1).max(64),
    threadId: ThreadId.and(boundedId),
    interactionId: InteractionId.and(boundedId),
    optionId: boundedId,
  }),
]);
export type NotificationAction = z.infer<typeof NotificationAction>;
/** What a notification action ended as. Only `confirmed` means the daemon accepted the answer. */
export type ActionOutcome = "stale" | "unreachable" | "unsaved" | "saved" | "confirmed" | "refused";

type Put = (key: string, read: () => Record<string, unknown>) => void;
type Schedule = (delayMs: number, run: () => void) => () => void;
/** Minutes after local midnight now, from the host's clock. */
type MinuteOfDay = () => number;

/**
 * Local notifications for the iOS app. Alerts come only from the daemon's canonical
 * `notification` messages and its catch-up feed; nothing here derives an alert from status.
 */
export class NotificationBridge {
  #client: ClientCore;
  #put: Put;
  #schedule: Schedule;
  #enabled = false;
  #appState: AppState = "foreground";
  #cursor = 0;
  #phone: PhoneNotificationPrefs = defaultPhonePrefs;
  #minuteOfDay: MinuteOfDay;
  /** False until Swift reports on/off; the runtime's default must not unregister a device. */
  #synced = false;
  /** What this connection has told the daemon; unknown again after every reconnect. */
  #daemon: "registered" | "unregistered" | undefined;
  #connection = 0;
  /** Register/unregister/catch-up run one at a time, each against the latest on/off state. */
  #queue: Promise<void> = Promise.resolve();
  #stop: (() => void)[] = [];
  /** How long an action waits for this thread's confirmed state before giving up. */
  readonly detailsMs: number;

  constructor(
    client: ClientCore,
    put: Put,
    schedule: Schedule,
    minuteOfDay: MinuteOfDay,
    detailsMs = 8000,
  ) {
    this.#client = client;
    this.#minuteOfDay = minuteOfDay;
    this.#put = put;
    this.#schedule = schedule;
    this.detailsMs = detailsMs;
    const connection = client.connectionState();
    this.#stop.push(
      connection.subscribe(() => {
        if (connection.getSnapshot() === "ready") void this.#connected();
        else {
          this.#connection++;
          this.#daemon = undefined;
        }
      }),
      client.onMessage((message) => {
        if (message.type === "notification" && this.#enabled) this.#alert(message.notification);
      }),
    );
  }
  close(): void {
    for (const stop of this.#stop.splice(0)) stop();
  }
  handle(action: NotificationAction): void {
    switch (action.type) {
      case "notifications.sync": {
        const changed = action.appState !== this.#appState || action.enabled !== this.#enabled;
        this.#enabled = action.enabled;
        this.#synced = true;
        this.#appState = action.appState;
        if (action.phone) this.#phone = action.phone;
        this.#cursor = Math.max(this.#cursor, action.cursor);
        if (this.#client.state === "ready") {
          if (changed) this.#presence();
          void this.#follow();
        }
        return;
      }
      case "notifications.config":
        void this.#config();
        return;
      case "notifications.preferences":
        this.#send({ type: "notification.preferences", preferences: action.preferences });
        void this.#config();
        return;
      case "notifications.snooze":
        this.#send({ type: "notification.snooze", threadId: action.threadId, until: action.until });
        return;
      case "notifications.resolve":
        void this.#resolve(action).catch(() => this.#outcome(action.requestId, "unsaved"));
    }
  }
  async #connected(): Promise<void> {
    this.#presence();
    // Native state (on/off, app state, cursor) may postdate this runtime; ask for it again.
    this.#put("notifications:connected", () => ({ type: "notifications.connected" }));
    await this.#follow();
  }
  #follow(): Promise<void> {
    this.#queue = this.#queue.then(() => this.#reconcile());
    return this.#queue;
  }
  /**
   * On: register this phone once per connection, then catch up. Off: unregister once per
   * connection, so a mute that couldn't be sent, or a registration the daemon kept from an
   * earlier socket, is undone as soon as the phone reconnects.
   */
  async #reconcile(): Promise<void> {
    if (!this.#synced || this.#client.state !== "ready") return;
    const want = this.#enabled ? "registered" : "unregistered";
    if (this.#daemon !== want) {
      const connection = this.#connection;
      try {
        if (want === "registered")
          await this.#client.request({
            type: "notification.register",
            device: { channel: "websocket", platform: "phone" },
          });
        else await this.#client.request({ type: "notification.unregister" });
      } catch {
        return; // The next connection retries; catch-up needs a registered device.
      }
      if (connection !== this.#connection) return;
      this.#daemon = want;
    }
    if (want === "registered") await this.#catchUp();
  }
  /** The daemon stops counting a backgrounded socket as delivered (it may be suspended). */
  #presence(): void {
    this.#send({
      type: "presence.update",
      threadId: null,
      inputAgeMs: 0,
      appState: this.#appState,
    });
  }
  #send(message: Parameters<ClientCore["send"]>[0]): void {
    try {
      this.#client.send(message);
    } catch {
      // Offline: the next connection sends current presence and catches up.
    }
  }
  async #catchUp(): Promise<void> {
    let feed: NotificationFeed;
    try {
      feed = await this.#client.request({ type: "notification.feed", afterCursor: this.#cursor });
    } catch {
      return;
    }
    this.#cursor = feed.cursor;
    this.#put("notifications:feed", () => ({
      type: "notifications.feed",
      cursor: feed.cursor,
      entries: feed.entries.map((entry) => this.#delivered(entry.notification)),
      retracted: feed.retracted,
    }));
  }
  #alert(notification: Notification): void {
    this.#put(`notifications:alert:${notification.id}`, () => ({
      type: "notifications.alert",
      notification: this.#delivered(notification),
    }));
  }
  /** The alert with how this phone shows it now (`notification-delivery.ts`). */
  #delivered(notification: Notification): Notification & { delivery: PhoneDelivery } {
    const delivery = phoneDelivery(notification.status, this.#phone, {
      foreground: this.#appState === "foreground",
      minuteOfDay: this.#minuteOfDay(),
    });
    return { ...notification, delivery };
  }
  async #config(): Promise<void> {
    try {
      const result = await this.#client.request({ type: "notification.config" });
      this.#put("notifications:config", () => ({
        type: "notifications.config",
        preferences: result.preferences,
      }));
    } catch {
      // Settings keep their last known values.
    }
  }
  #outcome(id: string, outcome: ActionOutcome): void {
    this.#put(`notifications:action:${id}`, () => ({ type: "notifications.action", id, outcome }));
  }
  /**
   * ADR 0012: an action answers only what is pending now. It reads the thread's confirmed state
   * first, then sends the exact canonical option through the durable command path.
   */
  async #resolve(action: Extract<NotificationAction, { type: "notifications.resolve" }>) {
    const lease = this.#client.thread(action.threadId);
    try {
      if (!(await this.#confirmed(lease.store)))
        return this.#outcome(action.requestId, "unreachable");
      const interaction = lease.store.interaction(action.interactionId);
      const option =
        interaction?.state === "pending" && interaction.request.kind === "approval"
          ? interaction.request.options.find((candidate) => candidate.id === action.optionId)
          : undefined;
      if (!option) return this.#outcome(action.requestId, "stale");
      // One patch key per action: a receipt can land before admission returns, and must win.
      let receipted = false;
      await submitCommand(
        this.#client,
        {
          type: "interaction.resolve",
          interactionId: action.interactionId,
          resolution: { kind: "approval", optionId: option.id },
        },
        () => {
          if (!receipted) this.#outcome(action.requestId, "saved");
        },
        (result) => {
          receipted = true;
          this.#outcome(action.requestId, result.ok ? "confirmed" : "refused");
        },
      );
    } finally {
      lease.release();
    }
  }
  /** True once the store holds daemon-confirmed state; false on error or timeout. */
  #confirmed(store: ThreadSource): Promise<boolean> {
    const state = () =>
      store.error ? false : store.thread && !store.syncing && !store.unconfirmed ? true : undefined;
    const now = state();
    if (now !== undefined) return Promise.resolve(now);
    return new Promise((resolve) => {
      let done = false;
      const finish = (value: boolean) => {
        if (done) return;
        done = true;
        stop();
        cancel();
        resolve(value);
      };
      const stop = store.observe(() => {
        const value = state();
        if (value !== undefined) finish(value);
      });
      const cancel = this.#schedule(this.detailsMs, () => finish(false));
    });
  }
}
