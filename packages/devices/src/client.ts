import { deviceInputTimeout } from "./input-budget.ts";
import { z } from "zod";
import { PendingScreenshots } from "./client-screenshots.ts";
import {
  decodeStreamMessage,
  isStreamPiece,
  StreamAssembler,
  type PictureChunk,
  type StreamMessage,
} from "@ace/browser/stream";
import {
  channelPath,
  MediaSubscriptions,
  PictureQueue,
  SharedStreams,
  type MediaRoute,
  type SourcePicture,
  type Stamped,
} from "@ace/browser/live-view";
import type { MediaPoster } from "@ace/protocol";
import {
  type AppDevice as Device,
  type DeviceAck,
  DeviceClientMessage,
  DeviceOperation,
  DeviceServerMessage,
  DeviceState,
  DeviceFailure,
  DeviceInventory,
} from "@ace/protocol/devices";

/** One live picture of a device's screen (its source id is the device id). */
export type DevicePicture = SourcePicture;

export interface DeviceTransportEvents {
  /** Only call after the host authenticates the dedicated devices channel. */
  ready(): void;
  message(data: unknown): void;
  close(): void;
  /** Admission is retryable; the transport owns the delayed retry. */
  limited?(error: DeviceClientError): void;
}
export interface DeviceTransport {
  open(events: DeviceTransportEvents): void;
  send(message: DeviceClientMessage | DeviceAck): void | Promise<void>;
  close(): void;
}
export interface DeviceClientOptions {
  /** Unique across every request, including timed-out requests and reconnects. */
  id(): string;
  schedule(callback: () => void, delayMs: number): () => void;
}
export class DeviceClientError extends Error {
  readonly code: string;
  readonly hint: string;
  /** The macOS permission the daemon's screen helper lacks, when that is the cause. */
  readonly permission: DeviceFailure["permission"];
  constructor(code: string, message: string, hint = "", permission?: DeviceFailure["permission"]) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.permission = permission;
  }
}
export interface DeviceClientSnapshot {
  connected: boolean;
  inventoryLoaded: boolean;
  devices: readonly Device[];
  states: readonly DeviceState[];
  issues: readonly DeviceFailure[];
  /** Devices are on for the daemon's machine, once the daemon has said either way. */
  enabled?: boolean;
  error?: DeviceClientError;
}
export type DeviceLogBatch = Extract<DeviceServerMessage, { type: "devices.logs" }>;
type Pending = {
  resolve(data: unknown): void;
  reject(error: Error): void;
  cancel(): void;
  operation: DeviceOperation;
  /** A `subscribe`'s generation, matched by its reply (`MediaSubscriptions`). */
  generation?: number;
};
const inventory = DeviceInventory;
const statesResult = z.object({
  states: z.array(DeviceState).max(32),
  /** Older daemons leave it out; their states carry it instead. */
  enabled: z.boolean().optional(),
});
const enableResult = z.object({ enabled: z.boolean() });
/** A screenshot request resolves with its picture (`PendingScreenshots`), never wire data. */
const isPicture = (value: unknown): value is DevicePicture =>
  typeof value === "object" &&
  value !== null &&
  "bytes" in value &&
  value.bytes instanceof Uint8Array;

/** No credentials, automatic reapproval or replayed input. The host owns reconnect. */
export class DeviceClient {
  private readonly options: DeviceClientOptions;
  private readonly pending = new Map<string, Pending>();
  private readonly screenshots = new PendingScreenshots();
  private readonly states = new Map<string, DeviceState>();
  private readonly listeners = new Set<(snapshot: DeviceClientSnapshot) => void>();
  private readonly logListeners = new Map<string, Set<(batch: DeviceLogBatch) => void>>();
  private devices: Device[] = [];
  private inventoryLoaded = false;
  private issues: DeviceFailure[] = [];
  private enabled: boolean | undefined;
  private connected = false;
  private transport: DeviceTransport | undefined;
  private error: DeviceClientError | undefined;
  private epoch = 0;
  /** Stream kind messages (`@ace/browser/stream`) being put back together. */
  private readonly assembler = new StreamAssembler();
  private readonly pictures = new PictureQueue(4);
  /** Which devices' pictures come by the media connection (ADR 0147 §4). */
  private readonly media = new MediaSubscriptions();
  private stopMedia: (() => void) | undefined;
  constructor(options: DeviceClientOptions) {
    this.options = options;
  }
  /**
   * Take live pictures by this media connection when it has a binding: each held stream
   * subscribes again whenever the binding changes, acks follow the pictures, and requests and
   * state stay on this channel. `undefined` goes back to the channel alone.
   */
  useMedia(route: MediaRoute | undefined): void {
    this.stopMedia?.();
    this.stopMedia = undefined;
    this.media.use(route);
    if (!route) return;
    const stops = [
      route.watch(() => {
        if (!this.connected) return;
        for (const deviceId of this.liveStreams.held()) this.subscribe(deviceId);
      }),
      route.onStream((message) => this.receiveMedia(message)),
    ];
    this.stopMedia = () => {
      for (const stop of stops) stop();
    };
  }
  /**
   * The view of `deviceId` couldn't decode `codec` (HEVC, say): that one stream subscribes again
   * without it, while every other source keeps the codecs it plays. False when nothing is left
   * to fall back to (H.264 itself failed).
   */
  fallBack(deviceId: string, codec: string): boolean {
    if (!this.media.fallBack(deviceId, codec)) return false;
    if (this.liveStreams.held().includes(deviceId)) this.subscribe(deviceId);
    return true;
  }
  /** The still the device's subscribe brought back, to show until its first live picture. */
  poster(deviceId: string): MediaPoster | undefined {
    return this.media.poster(deviceId);
  }
  private acceptInventory(devices: Device[]): void {
    this.devices = devices;
    this.inventoryLoaded = true;
    const ids = new Set(devices.map((device) => device.id));
    for (const [id, state] of this.states) {
      if (
        !ids.has(id) &&
        !state.threadId &&
        !state.booting &&
        !state.cleanupRequired &&
        ["idle", "failed"].includes(state.lifecycle)
      )
        this.states.delete(id);
    }
  }
  getSnapshot(): DeviceClientSnapshot {
    return {
      connected: this.connected,
      inventoryLoaded: this.inventoryLoaded,
      devices: this.devices,
      issues: this.issues,
      states: [...this.states.values()],
      ...(this.enabled === undefined ? {} : { enabled: this.enabled }),
      ...(this.error ? { error: this.error } : {}),
    };
  }
  watch(listener: (snapshot: DeviceClientSnapshot) => void): () => void {
    if (this.listeners.size >= 64) throw new DeviceClientError("limit", "Device listener limit");
    this.listeners.add(listener);
    try {
      listener(this.getSnapshot());
    } catch (error) {
      this.listeners.delete(listener);
      throw error;
    }
    return () => {
      this.listeners.delete(listener);
    };
  }
  connect(transport: DeviceTransport): void {
    this.disconnect();
    this.transport = transport;
    const epoch = ++this.epoch;
    const current = () => this.epoch === epoch;
    try {
      transport.open({
        ready: () => {
          if (current()) {
            this.connected = true;
            this.error = undefined;
            this.notify();
          }
        },
        message: (data) => {
          if (current()) this.receive(data);
        },
        close: () => {
          if (current()) this.disconnect();
        },
        limited: (error) => {
          if (current()) {
            this.connected = false;
            this.error = error;
            this.notify();
          }
        },
      });
    } catch (error) {
      this.fail(error);
    }
  }
  disconnect(): void {
    ++this.epoch;
    const transport = this.transport;
    this.transport = undefined;
    this.connected = false;
    this.liveStreams.reset();
    this.media.reset();
    this.states.clear();
    this.devices = [];
    this.inventoryLoaded = false;
    this.issues = [];
    this.enabled = undefined;
    this.assembler.reset();
    this.pictures.discard();
    this.screenshots.clear();
    for (const pending of this.pending.values()) {
      pending.cancel();
      pending.reject(
        new DeviceClientError(
          "disconnected",
          "Device connection closed",
          "Reconnect and take control again.",
        ),
      );
    }
    this.pending.clear();
    transport?.close();
    this.notify();
  }
  request(raw: DeviceOperation): Promise<unknown> {
    return this.send(raw, undefined);
  }
  private send(raw: DeviceOperation, generation: number | undefined): Promise<unknown> {
    const operation = DeviceOperation.parse(raw);
    const epoch = this.epoch;
    const transport = this.transport;
    if (!transport || !this.connected)
      return Promise.reject(new DeviceClientError("disconnected", "Devices are offline"));
    if (this.pending.size >= 32)
      return Promise.reject(new DeviceClientError("limit", "Too many pending device requests"));
    const message = DeviceClientMessage.parse({
      type: "devices.request",
      requestId: this.options.id(),
      operation,
    });
    if (this.pending.has(message.requestId))
      return Promise.reject(new DeviceClientError("invalid_data", "Duplicate device request id"));
    if (operation.op === "screenshot") {
      try {
        this.screenshots.begin(message.requestId, operation.deviceId);
      } catch {
        return Promise.reject(new DeviceClientError("limit", "Pending screenshot limit"));
      }
    }
    return new Promise((resolve, reject) => {
      const cancel = this.options.schedule(
        () => {
          this.pending.delete(message.requestId);
          this.screenshots.cancel(message.requestId);
          reject(
            new DeviceClientError(
              "timeout",
              "Device request timed out",
              "Check device state before retrying input.",
            ),
          );
        },
        operation.op === "record.stop"
          ? 180000
          : operation.op === "boot"
            ? 250000
            : operation.op === "install"
              ? 610000
              : operation.op === "start"
                ? 120000
                : operation.op === "input"
                  ? Math.max(60000, deviceInputTimeout(operation.input) + 5000)
                  : 60000,
      );
      this.pending.set(message.requestId, {
        resolve,
        reject,
        cancel,
        operation,
        ...(generation === undefined ? {} : { generation }),
      });
      try {
        void Promise.resolve(transport.send(message)).catch((error: unknown) =>
          this.rejectSend(message.requestId, error, epoch),
        );
      } catch (error) {
        this.rejectSend(message.requestId, error, epoch);
      }
    });
  }
  /**
   * A still of the device's screen as a JPEG: the daemon sends it on the media stream just
   * before the result that names it.
   */
  async screenshot(deviceId: string): Promise<DevicePicture> {
    const picture = await this.request({ op: "screenshot", deviceId });
    if (!isPicture(picture))
      throw new DeviceClientError("invalid", "Screenshot pixels missing or mismatched");
    return picture;
  }

  /**
   * A device's live pictures (stream kind `deviceFrame`), in order. Ack each with `ack` once
   * shown, or at once when it can't be: the daemon sends a window's worth ahead and no more.
   */
  watchPictures(deviceId: string, draw: (picture: DevicePicture) => Promise<void>): () => void {
    try {
      return this.pictures.watch(deviceId, async (picture) => {
        if (this.connected) await draw(picture);
      });
    } catch {
      throw new DeviceClientError("limit", "Device frame view limit");
    }
  }

  /**
   * The view showed `picture` (and every one before it); `keyframe`: its decoder lost its place.
   * Never answered and never retried: a lost ack only holds the stream until the next one.
   */
  ack(picture: DevicePicture, keyframe = false): void {
    const transport = this.transport;
    if (picture.still || !transport || !this.connected) return;
    const message: DeviceAck = {
      type: "devices.ack",
      deviceId: picture.sourceId,
      streamId: picture.streamId,
      sequence: picture.sequence,
      ...(keyframe ? { keyframe: true as const } : {}),
    };
    const way = this.media.way(picture.sourceId, picture.generation);
    // A picture of an earlier subscribe: its ack belongs to a delivery that is gone.
    if (way === "stale") return;
    if (way === "media") return void this.media.route?.ack(message);
    try {
      void Promise.resolve(transport.send(message)).catch(() => {});
    } catch {
      /* The channel is closing; its close resets the view. */
    }
  }

  private readonly liveStreams = new SharedStreams();
  /** Whether `picture` is of its device's current subscribe: an older one is never drawn. */
  current(picture: DevicePicture): boolean {
    return this.media.current(picture.sourceId, picture.generation);
  }
  private subscribe(deviceId: string): void {
    const { generation, fields } = this.media.begin(deviceId);
    // What the earlier subscribe delivered and nobody drew yet is stale now.
    this.pictures.discardSource(deviceId);
    void this.send({ op: "subscribe", deviceId, ...fields }, generation).catch((error: unknown) => {
      // A connection the daemon won't bind here: the stream goes on this channel instead.
      if (this.media.refused(deviceId, generation, error)) this.subscribe(deviceId);
    });
  }
  private receiveMedia(message: StreamMessage): void {
    const connection = this.media.route?.binding()?.connection;
    if (message.kind !== "device.frame" || !connection || !this.connected) return;
    if (message.frame.still) return;
    this.publishPicture(message.sourceId, message.frame, connection);
  }
  /** A live picture that came by `path`, stamped with its delivery's generation, else dropped. */
  private publishPicture(sourceId: string, frame: PictureChunk, path: string): void {
    const stamped = this.media.arrive(sourceId, path, frame);
    if (stamped)
      this.pictures.publish({ ...stamped.frame, sourceId, generation: stamped.generation });
  }
  /**
   * What a subscribe's reply released: the pictures that came its settled way while it was on its
   * way, shown now; past the buffer's bounds, the delivery is asked for a fresh keyframe.
   */
  private release(
    sourceId: string,
    released: { pictures: readonly Stamped[]; needsKeyframe: boolean },
  ): void {
    for (const { frame, generation } of released.pictures)
      this.pictures.publish({ ...frame, sourceId, generation });
    const first = released.pictures[0];
    if (released.needsKeyframe && first)
      this.ack({ ...first.frame, sourceId, generation: first.generation }, true);
  }

  /**
   * Keep `deviceId`'s live stream open for one view. Views of the same device share one daemon
   * subscription: the first view subscribes, the last to release unsubscribes.
   */
  retainStream(deviceId: string): () => void {
    return this.liveStreams.retain(
      deviceId,
      () => this.subscribe(deviceId),
      () => {
        this.media.forget(deviceId);
        void this.request({ op: "unsubscribe", deviceId }).catch(() => {});
      },
    );
  }

  watchLogs(deviceId: string, listener: (batch: DeviceLogBatch) => void): () => void {
    let listeners = this.logListeners.get(deviceId);
    if (!listeners) {
      if (this.logListeners.size >= 4)
        throw new DeviceClientError("limit", "Device log view limit");
      listeners = new Set();
      this.logListeners.set(deviceId, listeners);
    }
    if (listeners.size >= 64) throw new DeviceClientError("limit", "Device log listener limit");
    listeners.add(listener);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      listeners.delete(listener);
      if (!listeners.size) this.logListeners.delete(deviceId);
    };
  }
  private rejectSend(id: string, error: unknown, epoch: number): void {
    if (epoch !== this.epoch) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    this.screenshots.cancel(id);
    pending.cancel();
    pending.reject(
      error instanceof Error ? error : new DeviceClientError("disconnected", "Device send failed"),
    );
  }
  private receive(data: unknown): void {
    try {
      if (!this.connected)
        throw new DeviceClientError("disconnected", "Unauthenticated device message");
      if (data instanceof Uint8Array) {
        if (!isStreamPiece(data))
          throw new DeviceClientError(
            "invalid_data",
            "Device binary message is not a stream piece",
          );
        this.receivePiece(data);
        return;
      }
      if (typeof data === "string") {
        if (data.length > 2 * 1024 * 1024)
          throw new DeviceClientError("limit", "Device message exceeds limit");
        data = JSON.parse(data);
      }
      // Another feature's message (a daemon pushing screen state to every connection, say)
      // is skipped, never fatal: only devices messages are held to this schema.
      if (
        typeof data === "object" &&
        data !== null &&
        "type" in data &&
        typeof data.type === "string" &&
        !data.type.startsWith("devices.")
      )
        return;
      const message = DeviceServerMessage.parse(data);
      if (message.type === "devices.state") {
        this.putState(message.state);
        this.notify();
      } else if (message.type === "devices.enabled") {
        this.enabled = message.enabled;
        this.notify();
      } else if (message.type === "devices.inventory") {
        this.acceptInventory(message.devices);
        this.issues = message.issues;
        this.notify();
      } else if (message.type === "devices.logs") {
        for (const listener of this.logListeners.get(message.deviceId) ?? []) listener(message);
      } else {
        const pending = this.pending.get(message.requestId);
        if (!pending) return;
        this.pending.delete(message.requestId);
        pending.cancel();
        if (!message.ok) {
          this.screenshots.cancel(message.requestId);
          pending.reject(this.failure(message.error));
          return;
        }
        try {
          if (pending.operation.op === "screenshot") {
            // A screenshot resolves with its picture, not the result that names it.
            const image = this.screenshots.complete(message.requestId, message.data);
            if (image) pending.resolve(image);
            else
              pending.reject(
                new DeviceClientError("invalid", "Screenshot pixels missing or mismatched"),
              );
            return;
          }
          if (pending.operation.op === "subscribe" && pending.generation !== undefined) {
            this.release(
              pending.operation.deviceId,
              this.media.subscribed(pending.operation.deviceId, pending.generation, message.media),
            );
            if (this.media.poster(pending.operation.deviceId)) this.notify();
          }
          if (pending.operation.op === "list") {
            const found = inventory.parse(message.data);
            this.acceptInventory(found.devices);
            this.issues = found.issues;
            this.notify();
          }
          if (["controller", "start", "stop"].includes(pending.operation.op)) {
            this.putState(DeviceState.parse(message.data));
            this.notify();
          }
          if (pending.operation.op === "enable") {
            this.enabled = enableResult.parse(message.data).enabled;
            this.notify();
          }
          if (pending.operation.op === "states") {
            const result = statesResult.parse(message.data);
            if (result.enabled !== undefined) this.enabled = result.enabled;
            this.states.clear();
            for (const state of result.states) this.putState(state);
            this.notify();
          }
          pending.resolve(message.data);
        } catch (error) {
          pending.reject(error instanceof Error ? error : new Error("Invalid device result"));
          throw error;
        }
      }
    } catch (error) {
      this.fail(error);
    }
  }
  private receivePiece(data: Uint8Array): void {
    const envelope = this.assembler.push(data);
    // Kinds this client doesn't draw are skipped, never fatal.
    const message = envelope && decodeStreamMessage(envelope);
    if (message?.kind !== "device.frame") return;
    const picture = { ...message.frame, sourceId: message.sourceId };
    if (picture.still) this.screenshots.retain(picture);
    else this.publishPicture(message.sourceId, message.frame, channelPath);
  }
  private putState(state: DeviceState): void {
    const previous = this.states.get(state.device.id);
    if (!previous && this.states.size >= 32)
      throw new DeviceClientError("limit", "Device state limit");
    this.states.set(state.device.id, state);
    // A new capture needs a subscription even if its view stayed mounted.
    if (
      state.streamId &&
      state.lifecycle === "live" &&
      (state.streamId !== previous?.streamId || previous?.lifecycle !== "live")
    )
      this.liveStreams.refresh(state.device.id, () => this.subscribe(state.device.id));
  }
  private failure(error: DeviceFailure | undefined): DeviceClientError {
    return error
      ? new DeviceClientError(error.code, error.message, error.hint, error.permission)
      : new DeviceClientError("command_failed", "Device request failed");
  }
  private fail(error: unknown): void {
    this.error =
      error instanceof DeviceClientError
        ? error
        : new DeviceClientError(
            "invalid_data",
            error instanceof Error ? error.message : "Invalid device message",
          );
    this.disconnect();
  }
  private notify(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        this.listeners.delete(listener);
      }
    }
  }
}
