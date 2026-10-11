import { deviceInputTimeout } from "./input-budget.ts";
import { z } from "zod";
import { PendingScreenshots } from "./client-screenshots.ts";
import {
  type AppDevice as Device,
  DeviceClientMessage,
  DeviceOperation,
  DeviceServerMessage,
  DeviceState,
  DeviceFailure,
  DeviceInventory,
} from "@ace/protocol/devices";
import {
  LatestFrameHub,
  ScreenFrameReader,
  SharedStreams,
  type PortableFrame,
} from "@ace/screen/frames-client";

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
  send(message: DeviceClientMessage): void | Promise<void>;
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
};
const inventory = DeviceInventory;
const statesResult = z.object({
  states: z.array(DeviceState).max(32),
  /** Older daemons leave it out; their states carry it instead. */
  enabled: z.boolean().optional(),
});
const enableResult = z.object({ enabled: z.boolean() });

/** No credentials, automatic reapproval or replayed input. The host owns reconnect. */
export class DeviceClient {
  private readonly options: DeviceClientOptions;
  private readonly pending = new Map<string, Pending>();
  private readonly screenshots = new PendingScreenshots();
  private readonly states = new Map<string, DeviceState>();
  private readonly streams = new Map<string, string>();
  private readonly frameHubs = new Map<
    string,
    {
      hub: LatestFrameHub<{ frame: PortableFrame; epoch: number; direct?: boolean }>;
      consumers: number;
    }
  >();
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
  private reader: ScreenFrameReader;
  constructor(options: DeviceClientOptions) {
    this.options = options;
    this.reader = this.createReader();
  }
  private createReader(): ScreenFrameReader {
    return new ScreenFrameReader((frame) => {
      const id = this.streams.get(frame.header.sessionId);
      if (id) this.frameHubs.get(id)?.hub.publish({ frame, epoch: this.epoch });
      this.screenshots.retain(frame);
    });
  }
  private acceptInventory(devices: Device[]): void {
    this.devices = devices;
    this.inventoryLoaded = true;
    const ids = new Set(devices.map((device) => device.id));
    for (const [id, state] of this.states) {
      if (
        !ids.has(id) &&
        !state.approved &&
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
    this.streams.clear();
    this.liveStreams.reset();
    this.states.clear();
    this.devices = [];
    this.inventoryLoaded = false;
    this.issues = [];
    this.enabled = undefined;
    this.reader.reset();
    this.screenshots.clear();
    for (const entry of this.frameHubs.values()) entry.hub.discardPending();
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
      this.pending.set(message.requestId, { resolve, reject, cancel, operation });
      try {
        void Promise.resolve(transport.send(message)).catch((error: unknown) =>
          this.rejectSend(message.requestId, error, epoch),
        );
      } catch (error) {
        this.rejectSend(message.requestId, error, epoch);
      }
    });
  }
  watchFrames(deviceId: string, render: (frame: PortableFrame) => Promise<void>): () => void {
    let entry = this.frameHubs.get(deviceId);
    if (!entry) {
      if (this.frameHubs.size >= 4) throw new DeviceClientError("limit", "Device frame view limit");
      entry = { hub: new LatestFrameHub(), consumers: 0 };
      this.frameHubs.set(deviceId, entry);
    }
    const selected = entry;
    const release = selected.hub.subscribe(async ({ frame, epoch, direct }) => {
      if (
        this.epoch === epoch &&
        this.connected &&
        (direct || this.streams.get(frame.header.sessionId) === deviceId)
      )
        await render(frame);
    });
    selected.consumers++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
      selected.consumers--;
      if (selected.consumers === 0) this.frameHubs.delete(deviceId);
    };
  }

  private readonly liveStreams = new SharedStreams();
  /**
   * Keep `deviceId`'s live stream open for one view. Views of the same device share one daemon
   * subscription: the first view subscribes, the last to release unsubscribes.
   */
  retainStream(deviceId: string): () => void {
    return this.liveStreams.retain(
      deviceId,
      () => void this.request({ op: "subscribe", deviceId }).catch(() => {}),
      () => void this.request({ op: "unsubscribe", deviceId }).catch(() => {}),
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
        this.reader.push(data);
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
            const image = this.screenshots.complete(message.requestId, message.data);
            if (!image) {
              pending.reject(
                new DeviceClientError("invalid", "Screenshot pixels missing or mismatched"),
              );
              return;
            }
            this.frameHubs
              .get(image.deviceId)
              ?.hub.publish({ frame: image.frame, epoch: this.epoch, direct: true });
          }
          if (pending.operation.op === "list") {
            const found = inventory.parse(message.data);
            this.acceptInventory(found.devices);
            this.issues = found.issues;
            this.notify();
          }
          if (["controller", "approve", "start", "stop"].includes(pending.operation.op)) {
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
            this.streams.clear();
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
  private putState(state: DeviceState): void {
    const previous = this.states.get(state.device.id);
    if (!previous && this.states.size >= 32)
      throw new DeviceClientError("limit", "Device state limit");
    if (previous?.streamId) this.streams.delete(previous.streamId);
    this.states.set(state.device.id, state);
    if (state.streamId && state.lifecycle === "live") {
      this.streams.set(state.streamId, state.device.id);
      if (state.streamId !== previous?.streamId || previous?.lifecycle !== "live")
        this.liveStreams.refresh(
          state.device.id,
          () => void this.request({ op: "subscribe", deviceId: state.device.id }).catch(() => {}),
        );
    }
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
