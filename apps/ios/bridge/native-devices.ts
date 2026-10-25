import { DeviceClient, DeviceClientError } from "@ace/client/devices";
import {
  AppDeviceId,
  DeviceAck,
  DeviceChromeResult,
  DeviceOperation,
  ScreenUITreeResult,
  ThreadId,
} from "@ace/protocol";
import {
  deviceGesture,
  deviceKind,
  deviceProblem,
  deviceScreen,
  holdsControl,
  type DeviceProblem,
} from "@ace/ui-core/devices";
import type { AppDevice } from "@ace/protocol";
import { phoneChrome, type PhoneChrome } from "./phone-chrome.ts";
import { z } from "zod";
import { appendLogs, logView, treeRows, type LogTail } from "./device-details.ts";
import { phoneDevicesView, type AgentLabel, type Holder } from "./devices-view.ts";
import { scheduler } from "./host.ts";
import type { PatchSink } from "./agents.ts";
import {
  nativeFeatureChannel,
  NativeFeatureConnection,
  type NativeFeatureConfig,
} from "./native-feature-channel.ts";

const Press = z.object({
  x: z.number().finite().min(0).max(16384),
  y: z.number().finite().min(0).max(16384),
  at: z.number().finite(),
});
/** One reply each. `threadId` is the thread a person acts from: a first action takes control. */
export const NativeDeviceRequest = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("devices.request"),
    operation: DeviceOperation,
    threadId: ThreadId.optional(),
  }),
  /** A finger's press and release on the live screen, in device points: tap, swipe or hold. */
  z.object({
    type: z.literal("devices.gesture"),
    deviceId: AppDeviceId,
    threadId: ThreadId.optional(),
    start: Press,
    end: Press,
  }),
  /** The UI tree agents read, with their `@eN` refs. */
  z.object({ type: z.literal("devices.tree"), deviceId: AppDeviceId }),
]);
export const NativeDeviceControl = z.discriminatedUnion("type", [
  DeviceAck,
  z.object({ type: z.literal("native.devices.close") }),
  z.object({ type: z.literal("native.devices.unwatch"), deviceId: DeviceAck.shape.deviceId }),
  z.object({ type: z.literal("native.devices.release"), deviceId: DeviceAck.shape.deviceId }),
  /** The Devices screen is showing for a thread, with this device open and this search. */
  z.object({
    type: z.literal("native.devices.view"),
    threadId: ThreadId.optional(),
    deviceId: AppDeviceId.optional(),
    query: z.string().max(256).default(""),
    platform: z.enum(["all", "ios", "android"]).default("all"),
  }),
  z.object({ type: z.literal("native.devices.view.close") }),
  /** The logs sheet is showing (`filter` narrows it), or closed. */
  z.object({
    type: z.literal("native.devices.logs"),
    deviceId: AppDeviceId,
    on: z.boolean(),
    filter: z.string().max(256).default(""),
  }),
]);
type ViewWatch = Extract<z.infer<typeof NativeDeviceControl>, { type: "native.devices.view" }>;

const noop = () => {};
/** Devices of one model share a look; a device without a model is its own. */
const chromeKey = (device: Pick<AppDevice, "id" | "model">) => device.model ?? device.id;
/** The machine's answers that say the channel may not be used at all, not that it failed. */
const refusals = new Set(["permission_denied", "not_supported"]);

/** A failed device request in a person's words, with the macOS permission it lacks if any. */
export function deviceFailure(error: unknown): DeviceProblem {
  if (error instanceof DeviceClientError)
    return deviceProblem({
      code: error.code,
      message: error.message,
      hint: error.hint,
      permission: error.permission,
    });
  return { message: error instanceof Error ? error.message : "That didn't work.", hint: "" };
}

/** Operations that need the person's control lease; the first one takes it. */
const controlled = new Set<DeviceOperation["op"]>([
  "boot",
  "shutdown",
  "install",
  "open_app",
  "open_url",
  "configure",
  "input",
  "record.start",
  "record.stop",
  "clipboard.get",
  "clipboard.set",
]);

export interface NativeDevicesOptions {
  sink: PatchSink;
  now(): number;
  /** An agent of the thread open on the phone; undefined for anyone else's. */
  agent(holder: Holder): AgentLabel | undefined;
}

/** The shared authenticated devices channel. Input is never queued or replayed. */
/** How long a Devices screen waits before trying an unreachable channel again. */
const retryMs = 10_000;

export class NativeDevices {
  readonly client: DeviceClient;
  readonly connection: NativeFeatureConnection;
  readonly options: NativeDevicesOptions | undefined;
  #ack: ((value: z.infer<typeof DeviceAck>) => Promise<void>) | undefined;
  #view: ViewWatch | undefined;
  #stopView: (() => void) | undefined;
  #closed = false;
  /** The last open failed; a retry is scheduled while the screen stays open. */
  #unreachable = false;
  #retry: (() => void) | undefined;
  #leaseTimer: (() => void) | undefined;
  /** The agent each device was taken from, for Hand back. */
  #previous = new Map<string, Holder>();
  #logs: { deviceId: string; filter: string; tail: LogTail; release: () => void } | undefined;
  #claim: Promise<unknown> | undefined;
  /** Why the machine refused this screen's first reads. */
  #refused: DeviceProblem | undefined;
  /**
   * Each model's real look, asked once (`devices:chrome:<model>`); null when the machine has
   * none, absent while asking or after a failed ask.
   */
  #chromes = new Map<string, PhoneChrome | null>();
  #asking = new Set<string>();
  constructor(config: NativeFeatureConfig, options?: NativeDevicesOptions) {
    this.options = options;
    this.client = new DeviceClient({
      id: config.id,
      schedule: (callback, delay) => scheduler.set(delay, callback),
    });
    this.connection = new NativeFeatureConnection({
      state: () => this.client.getSnapshot(),
      watch: (listener) => this.client.watch(listener),
      end: () => this.client.disconnect(),
      begin: () => {
        const channel = nativeFeatureChannel(config, "devices");
        this.#ack = (value) => channel.send(value);
        this.client.connect(channel);
      },
    });
  }
  async request(raw: z.infer<typeof NativeDeviceRequest>, signal: AbortSignal): Promise<unknown> {
    await this.connection.ready(signal);
    if (raw.type === "devices.tree") {
      const result = ScreenUITreeResult.parse(
        await this.client.request({
          op: "ui.tree",
          deviceId: raw.deviceId,
          maxDepth: 16,
          maxNodes: 512,
        }),
      );
      return treeRows(result);
    }
    if (raw.type === "devices.gesture") {
      const input = deviceGesture(
        { x: Math.round(raw.start.x), y: Math.round(raw.start.y), at: raw.start.at },
        { x: Math.round(raw.end.x), y: Math.round(raw.end.y), at: raw.end.at },
      );
      return this.#act({ op: "input", deviceId: raw.deviceId, input }, raw.threadId);
    }
    const operation = raw.operation;
    // Pixels travel through the native socket and must never cross JSON/JSC.
    if (operation.op === "screenshot") throw new Error("Use the native live view");
    if (operation.op === "controller") return this.#controller(operation, raw.threadId);
    if (controlled.has(operation.op)) return this.#act(operation, raw.threadId);
    return this.client.request(operation);
  }
  handle(action: z.infer<typeof NativeDeviceControl>): void {
    switch (action.type) {
      case "native.devices.close":
        this.#closeView();
        this.#closeLogs();
        this.connection.close();
        this.#ack = undefined;
        return;
      case "devices.ack":
        void this.#ack?.(action).catch(() => {});
        return;
      case "native.devices.view":
        this.#watchView(action);
        return;
      case "native.devices.view.close":
        this.#closeView();
        return;
      case "native.devices.logs":
        if (action.on) this.#watchLogs(action.deviceId, action.filter);
        else this.#closeLogs();
        return;
      default:
        if (!this.client.getSnapshot().connected) return;
        void this.client
          .request(
            action.type === "native.devices.unwatch"
              ? { op: "unsubscribe", deviceId: action.deviceId }
              : { op: "controller", deviceId: action.deviceId, controller: "none" },
          )
          .catch(() => {});
    }
  }

  /** Take over remembers the agent it took the device from; Hand back returns it. */
  async #controller(
    operation: Extract<DeviceOperation, { op: "controller" }>,
    threadId: string | undefined,
  ): Promise<unknown> {
    const state = this.#state(operation.deviceId);
    const taking = operation.controller === "human";
    const operationWithThread =
      taking && threadId && !operation.threadId
        ? { ...operation, threadId: ThreadId.parse(threadId) }
        : operation;
    const result = await this.client.request(operationWithThread);
    if (taking && state?.controller === "agent" && state.holder)
      this.#previous.set(operation.deviceId, state.holder);
    else if (!taking) this.#previous.delete(operation.deviceId);
    this.#putView();
    return result;
  }
  /** One action that needs control: take it first when this connection doesn't hold it. */
  async #act(operation: DeviceOperation, threadId: string | undefined): Promise<unknown> {
    const deviceId = "deviceId" in operation ? operation.deviceId : undefined;
    if (deviceId && !holdsControl(this.#state(deviceId), this.#now())) {
      if (this.#state(deviceId)?.controller === "agent")
        throw new Error("An agent is using this device. Take over first.");
      this.#claim ??= this.client
        .request({
          op: "controller",
          deviceId,
          controller: "human",
          ...(threadId ? { threadId: ThreadId.parse(threadId) } : {}),
        })
        .finally(() => {
          this.#claim = undefined;
        });
      await this.#claim;
    }
    return this.client.request(operation);
  }
  #state(deviceId: string) {
    return this.client.getSnapshot().states.find((state) => state.device.id === deviceId);
  }
  #now(): number {
    return this.options?.now() ?? 0;
  }

  #watchView(watch: ViewWatch): void {
    const first = !this.#view;
    this.#view = watch;
    if (first) {
      this.#closed = false;
      let wasConnected = false;
      this.#stopView = this.client.watch((snapshot) => {
        if (wasConnected && !snapshot.connected) this.#closed = true;
        wasConnected ||= snapshot.connected;
        this.#putView();
      });
      void this.#load();
    } else this.#putView();
  }
  /** Read the inventory and states each time the screen opens or asks again. */
  async #load(): Promise<void> {
    const signal = new AbortController().signal;
    this.#retry?.();
    this.#retry = undefined;
    try {
      await this.connection.ready(signal);
      await this.client.request({ op: "inventory.watch", watching: true });
      await this.client.request({ op: "list" });
      await this.client.request({ op: "states" });
      this.#unreachable = false;
      this.#refused = undefined;
    } catch (error) {
      // The snapshot carries the channel's failure. A refusal arrives only as this answer, and
      // trying again won't change it: keep it so the screen says why instead of loading.
      this.#refused =
        error instanceof DeviceClientError && refusals.has(error.code)
          ? deviceFailure(error)
          : undefined;
      // A channel that never opened or never answered has no refusal, so the view would spin
      // forever. Say so, and try again while the screen stays open.
      const snapshot = this.client.getSnapshot();
      if (!this.#refused && this.#view && (!snapshot.connected || !snapshot.inventoryLoaded)) {
        this.#unreachable = true;
        this.#retry = scheduler.set(retryMs, () => {
          this.#retry = undefined;
          if (this.#view) void this.#load();
        });
      }
    }
    this.#putView();
  }
  /** Ask the machine for a model's look once, as PNG; the view names it when it arrives. */
  #askChrome(device: AppDevice): void {
    const key = chromeKey(device);
    if (this.#chromes.has(key) || this.#asking.has(key)) return;
    this.#asking.add(key);
    this.client
      .request({ op: "chrome", deviceId: device.id, format: "png" })
      .then((data) => {
        const chrome = DeviceChromeResult.parse(data).chrome;
        const kind = deviceKind(device);
        // A Simulator's look is in points already; a skin's pixels take the device's points.
        const upright =
          device.platform === "ios" && chrome ? chrome.screen : deviceScreen(kind, device.name);
        const shaped = chrome ? (phoneChrome(chrome, kind, upright) ?? null) : null;
        this.#chromes.set(key, shaped);
        if (shaped)
          this.options?.sink.put(`devices:chrome:${key}`, () => ({
            type: "devices.chrome",
            key,
            chrome: shaped,
          }));
        this.#putView();
      })
      .catch(() => {
        // Asked again when the screen next shows the device.
      })
      .finally(() => this.#asking.delete(key));
  }
  #closeView(): void {
    this.#retry?.();
    this.#retry = undefined;
    this.#unreachable = false;
    this.#stopView?.();
    this.#stopView = undefined;
    this.#view = undefined;
    this.#leaseTimer?.();
    this.#leaseTimer = undefined;
    this.options?.sink.clear("devices:view");
  }
  #putView(): void {
    const watch = this.#view;
    const options = this.options;
    if (!watch || !options) return;
    // Say "Your control ended" when the lease runs out, without waiting for another change.
    this.#leaseTimer?.();
    const now = options.now();
    const ends = this.client
      .getSnapshot()
      .states.flatMap((state) =>
        holdsControl(state, now) && state.leaseExpiresAt ? [state.leaseExpiresAt - now] : [],
      );
    this.#leaseTimer = ends.length
      ? scheduler.set(Math.min(...ends) + 50, () => this.#putView())
      : undefined;
    const open = watch.deviceId
      ? this.client.getSnapshot().devices.find((device) => device.id === watch.deviceId)
      : undefined;
    if (open) this.#askChrome(open);
    options.sink.put("devices:view", () => {
      const current = this.#view;
      if (!current) return undefined;
      return {
        type: "devices.view",
        threadId: current.threadId ?? "",
        view: phoneDevicesView({
          snapshot: this.client.getSnapshot(),
          closed: this.#closed,
          refused: this.#refused,
          unreachable:
            this.#unreachable &&
            (!this.client.getSnapshot().connected || !this.client.getSnapshot().inventoryLoaded),
          threadId: current.threadId,
          deviceId: current.deviceId,
          query: current.query,
          platform: current.platform,
          now: options.now(),
          agent: options.agent,
          previous: this.#previous,
          chrome: (device) => (this.#chromes.get(chromeKey(device)) ? chromeKey(device) : null),
        }),
      };
    });
  }

  #watchLogs(deviceId: string, filter: string): void {
    const logs = this.#logs;
    if (logs?.deviceId === deviceId) {
      logs.filter = filter;
      this.#putLogs();
      return;
    }
    this.#closeLogs();
    const tail: LogTail = { lines: [], dropped: 0 };
    let release: () => void = noop;
    const entry = { deviceId, filter, tail, release: () => release() };
    this.#logs = entry;
    try {
      release = this.client.watchLogs(deviceId, (batch) => {
        entry.tail = appendLogs(entry.tail, batch.lines, batch.dropped);
        this.#putLogs();
      });
    } catch {
      this.#putLogs("Couldn't start device logs.");
      return;
    }
    this.#putLogs();
    void this.connection
      .ready(new AbortController().signal)
      .then(() => this.client.request({ op: "logs.start", deviceId }))
      .catch(() => {
        if (this.#logs === entry) this.#putLogs("Couldn't start device logs.");
      });
  }
  #closeLogs(): void {
    const logs = this.#logs;
    if (!logs) return;
    this.#logs = undefined;
    logs.release();
    if (this.client.getSnapshot().connected)
      void this.client.request({ op: "logs.stop", deviceId: logs.deviceId }).catch(() => {});
    this.options?.sink.clear("devices:logs");
  }
  #putLogs(error = ""): void {
    this.options?.sink.put("devices:logs", () => {
      const logs = this.#logs;
      if (!logs) return undefined;
      return {
        type: "devices.logs",
        deviceId: logs.deviceId,
        error,
        ...logView(logs.tail, logs.filter),
      };
    });
  }
}
