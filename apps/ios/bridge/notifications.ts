import { z } from "zod";
import type { ClientCore } from "@ace/client";
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
  alertAnswer,
  alertRequest,
  confirmedState,
  type AlertRequest,
} from "./notification-request.ts";
import { sendPayload } from "./thread-controls.ts";
import {
  PhoneNotificationPrefs,
  alertDelivery,
  defaultPhonePrefs,
  phoneDelivery,
  type PhoneDelivery,
} from "./notification-delivery.ts";
import { accountView } from "@ace/ui-core";
import { host } from "./host.ts";
import { LimitWatch, type LimitAlert } from "./limit-alerts.ts";
import { RunWatch, type RunAlert } from "./run-alerts.ts";
import type { KeptValue } from "./kept-value.ts";

const boundedId = z.string().min(1).max(200);
/** As many recent runs as the web's inbox reads for its toasts. */
const runInboxLimit = 50;
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
  /** A question's answer from its notification: an offered option's id, or the person's words. */
  z.object({
    type: z.literal("notifications.answer"),
    requestId: z.string().min(1).max(64),
    threadId: ThreadId.and(boundedId),
    interactionId: InteractionId.and(boundedId),
    questionId: boundedId,
    value: z.string().min(1).max(8192),
  }),
  /** Reply from a notification: the words go to the thread as the next message. */
  z.object({
    type: z.literal("notifications.reply"),
    requestId: z.string().min(1).max(64),
    threadId: ThreadId.and(boundedId),
    text: z.string().min(1).max(8192),
  }),
]);
export type NotificationAction = z.infer<typeof NotificationAction>;
/** What a notification action ended as. Only `confirmed` means the daemon accepted the answer. */
export type ActionOutcome = "stale" | "unreachable" | "unsaved" | "saved" | "confirmed" | "refused";

/** Alerts as Swift receives them: how this phone shows each, and the request it asks about. */
type Delivered = Notification & { delivery: PhoneDelivery; request?: AlertRequest };
/** Most needs-you entries in one catch-up page whose request is read; the rest post plainly. */
const enrichLimit = 8;

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
  /** How long an alert waits to read its request before posting without it. */
  readonly requestMs: number;
  /** Usage-limit alerts: read while notifications are on, the machine is ready and limits are wanted. */
  #limits: LimitWatch | undefined;
  /** Automation-run alerts: read while notifications are on, the machine is ready and runs are wanted. */
  #runs: RunWatch | undefined;

  constructor(
    client: ClientCore,
    put: Put,
    schedule: Schedule,
    minuteOfDay: MinuteOfDay,
    detailsMs = 8000,
    requestMs = 1500,
    /** The phone's clock in milliseconds, for usage-limit and run alerts; none watched without it. */
    now?: () => number,
    /** How far this machine's runs were said, kept between launches (`run-alerts.ts`). */
    runProgress?: KeptValue,
  ) {
    this.requestMs = requestMs;
    this.#client = client;
    this.#minuteOfDay = minuteOfDay;
    this.#put = put;
    this.#schedule = schedule;
    this.detailsMs = detailsMs;
    if (now)
      this.#limits = new LimitWatch(
        async () =>
          (
            await client.request(
              { type: "accounts.list", requestId: host.uuid() },
              { timeoutMs: 15_000 },
            )
          ).accounts.map(accountView),
        schedule,
        now,
        (alert) => this.#limit(alert),
      );
    if (now)
      this.#runs = new RunWatch(
        // A page of recent runs, newest first; `before` reads further back.
        (before, finishedAfter) =>
          client.request(
            {
              type: "automation.inbox",
              limit: runInboxLimit,
              ...(before ? { before } : {}),
              ...(finishedAfter === undefined ? {} : { finishedAfter: Math.max(0, finishedAfter) }),
            },
            { timeoutMs: 15_000 },
          ),
        schedule,
        now,
        (alert) => this.#run(alert),
        runProgress,
      );
    const connection = client.connectionState();
    this.#stop.push(
      connection.subscribe(() => {
        if (connection.getSnapshot() === "ready") void this.#connected();
        else {
          this.#limits?.stop();
          this.#runs?.stop();
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
    this.#limits?.stop();
    this.#runs?.stop();
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
        this.#watchLimits();
        this.#watchRuns();
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
        return;
      case "notifications.answer":
        void this.#answer(action).catch(() => this.#outcome(action.requestId, "unsaved"));
        return;
      case "notifications.reply":
        void this.#reply(action).catch(() => this.#outcome(action.requestId, "unsaved"));
    }
  }
  /** Watches usage limits only while an alert could show: on, ready, and the category wanted. */
  #watchLimits(): void {
    const wanted =
      this.#enabled &&
      this.#client.state === "ready" &&
      (this.#phone.inApp.limits || this.#phone.system.limits);
    if (wanted) this.#limits?.start();
    else this.#limits?.stop();
  }
  /** One usage-limit change, with how this phone shows it now. */
  #limit(alert: LimitAlert): void {
    const delivery = phoneDelivery("limits", this.#phone, {
      foreground: this.#appState === "foreground",
      minuteOfDay: this.#minuteOfDay(),
    });
    this.#put(`notifications:limit:${alert.key}`, () => ({
      type: "notifications.limit",
      ...alert,
      delivery,
    }));
  }
  /**
   * Watches automation runs only while an alert could show. A dropped connection pauses it, so a
   * run that finished meanwhile is said on return; turning alerts off forgets where it was.
   */
  #watchRuns(): void {
    // Until Swift says what the person wants, nothing is known to be off: pause, never forget.
    if (!this.#synced) {
      this.#runs?.stop();
      return;
    }
    const wanted =
      this.#enabled && (this.#phone.inApp.automations || this.#phone.system.automations);
    if (!wanted) this.#runs?.forget();
    else if (this.#client.state === "ready") this.#runs?.start();
    else this.#runs?.stop();
  }
  /** One finished automation run, with how this phone shows it now. */
  #run(alert: RunAlert): void {
    const delivery = phoneDelivery("automations", this.#phone, {
      foreground: this.#appState === "foreground",
      minuteOfDay: this.#minuteOfDay(),
    });
    this.#put(`notifications:run:${alert.key}`, () => ({
      type: "notifications.run",
      ...alert,
      delivery,
    }));
  }
  async #connected(): Promise<void> {
    this.#watchLimits();
    this.#watchRuns();
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
    let asking = 0;
    const entries = await Promise.all(
      feed.entries.map((entry) =>
        entry.notification.interactionId && asking++ < enrichLimit
          ? this.#withRequest(entry.notification)
          : this.#delivered(entry.notification),
      ),
    );
    this.#put("notifications:feed", () => ({
      type: "notifications.feed",
      cursor: feed.cursor,
      entries,
      retracted: feed.retracted,
    }));
  }
  #alert(notification: Notification): void {
    void this.#withRequest(notification).then((delivered) =>
      this.#put(`notifications:alert:${notification.id}`, () => ({
        type: "notifications.alert",
        notification: delivered,
      })),
    );
  }
  /** The alert with how this phone shows it now (`notification-delivery.ts`). */
  #delivered(notification: Notification): Delivered {
    const facts = {
      status: notification.status,
      delegated: this.#delegated(notification.threadId),
    };
    const delivery = alertDelivery(facts, this.#phone, {
      foreground: this.#appState === "foreground",
      minuteOfDay: this.#minuteOfDay(),
    });
    return { ...notification, delivery };
  }
  /** The thread list says an agent delegated this thread; unknown reads as the person's own. */
  #delegated(threadId: string): boolean {
    const list = this.#client.threads();
    try {
      const entry = list.store.thread(threadId);
      return entry?.delegatedBy !== undefined || entry?.delegatedFrom !== undefined;
    } finally {
      list.release();
    }
  }
  /**
   * A needs-you alert says what is asked ("Claude Code wants to run a command") and offers a
   * short question's options, read from the thread's confirmed state. Past `requestMs`, or once
   * the request is gone, it posts as the daemon sent it.
   */
  async #withRequest(notification: Notification): Promise<Delivered> {
    const delivered = this.#delivered(notification);
    const interactionId = notification.interactionId;
    if (notification.status !== "needs_you" || !interactionId) return delivered;
    const lease = this.#client.thread(notification.threadId);
    try {
      if (!(await confirmedState(lease.store, this.#schedule, this.requestMs))) return delivered;
      const request = alertRequest(lease.store.interaction(interactionId), lease.store);
      return request ? { ...delivered, request } : delivered;
    } catch {
      return delivered;
    } finally {
      lease.release();
    }
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
      if (!(await confirmedState(lease.store, this.#schedule, this.detailsMs)))
        return this.#outcome(action.requestId, "unreachable");
      const interaction = lease.store.interaction(action.interactionId);
      const option =
        interaction?.state === "pending" && interaction.request.kind === "approval"
          ? interaction.request.options.find((candidate) => candidate.id === action.optionId)
          : undefined;
      if (!option) return this.#outcome(action.requestId, "stale");
      await this.#submit(action.requestId, {
        type: "interaction.resolve",
        interactionId: action.interactionId,
        resolution: { kind: "approval", optionId: option.id },
      });
    } finally {
      lease.release();
    }
  }
  /** A question answered from its notification: only the question pending now, as it asks. */
  async #answer(action: Extract<NotificationAction, { type: "notifications.answer" }>) {
    const lease = this.#client.thread(action.threadId);
    try {
      if (!(await confirmedState(lease.store, this.#schedule, this.detailsMs)))
        return this.#outcome(action.requestId, "unreachable");
      const interaction = lease.store.interaction(action.interactionId);
      const resolution = alertAnswer(interaction, action.questionId, action.value);
      if (!resolution) return this.#outcome(action.requestId, "stale");
      await this.#submit(action.requestId, {
        type: "interaction.resolve",
        interactionId: action.interactionId,
        resolution,
      });
    } finally {
      lease.release();
    }
  }
  /** Reply: the next message for the thread, delivered the way its composer would send it. */
  async #reply(action: Extract<NotificationAction, { type: "notifications.reply" }>) {
    const text = action.text.trim();
    if (!text) return this.#outcome(action.requestId, "refused");
    const lease = this.#client.thread(action.threadId);
    try {
      if (!(await confirmedState(lease.store, this.#schedule, this.detailsMs)))
        return this.#outcome(action.requestId, "unreachable");
      await this.#submit(
        action.requestId,
        sendPayload(lease.store, action.threadId, text, { opposite: false, setting: undefined }),
      );
    } finally {
      lease.release();
    }
  }
  /** Durable admission, then the daemon's receipt; a receipt that beats admission wins. */
  async #submit(id: string, payload: Parameters<typeof submitCommand>[1]) {
    let receipted = false;
    await submitCommand(
      this.#client,
      payload,
      () => {
        if (!receipted) this.#outcome(id, "saved");
      },
      (result) => {
        receipted = true;
        this.#outcome(id, result.ok ? "confirmed" : "refused");
      },
    );
  }
}
