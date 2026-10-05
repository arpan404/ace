import { DeviceStreamOwners } from "./stream-owners.ts";
import { watchDeviceLease } from "./lease-expiry.ts";
import { deviceStreamSnapshot } from "./snapshot.ts";
import { DeviceStreamControl, deviceImageStream } from "./stream-control.ts";
import { type Frame, type FrameSink } from "@ace/screen";
import { AppDevice as Device, DeviceOperation, DeviceState } from "@ace/protocol/devices";
import { deviceFailure } from "./failure.ts";
import { DeviceError } from "./sdk.ts";
import {
  startDevice,
  stopDevice,
  recordDevice,
  stopDeviceRecording,
  type LifecycleOwner,
  type LifecycleOptions,
} from "./lifecycle.ts";
import { createSession, type DeviceSession } from "./session.ts";
import type { Actor } from "./lease.ts";
import { performDeviceAction } from "./actions.ts";
import { approveDevice, disableDeviceSessions } from "./approval.ts";
import { enqueueDeviceInput } from "./input-queue.ts";
import type { spawnSupervised } from "@ace/provider-kit/process";
import { mirrorDeviceController } from "./screen-controller.ts";
import { InventoryWatch, sameDevice, type DeviceLog, type Inventory } from "./inventory.ts";

const simulatorBundle = "com.apple.iphonesimulator";
/** Expected refusals a person can act on; anything else is a fault worth a warning. */
const routine = new Set(["lease_required", "permission_denied", "busy", "not_booted"]);

export interface DevicesOptions extends LifecycleOptions {
  spawnLogs?: typeof spawnSupervised;
  /** Device and screen helper failures, for the daemon's redacting log. */
  log?: DeviceLog;
  /** How often the inventory is read again while a client watches (default four seconds). */
  inventoryIntervalMs?: number;
}
export class DevicesService {
  private readonly streamOwners = new DeviceStreamOwners();
  private enabled = false;
  private closed = false;
  private disabling = false;
  private readonly sessions = new Map<string, DeviceSession>();
  private readonly listeners = new Set<(state: DeviceState) => void>();
  private readonly options: DevicesOptions;
  /** The inventory read in flight, numbered in the order reads started. */
  private listing: { read: number; devices: Promise<Device[]> } | undefined;
  private reads = 0;
  private inventoryViews = 0;
  private readonly enabledListeners = new Set<(enabled: boolean) => void>();
  private readonly inventory: InventoryWatch;
  constructor(options: DevicesOptions) {
    this.options = options;
    this.inventory = new InventoryWatch({
      read: () => this.list(),
      after: options.runtime.after,
      intervalMs: options.inventoryIntervalMs ?? 4000,
      log: options.log,
    });
  }
  /** The inventory, joining a read already in flight. */
  async settleInventory(): Promise<void> {
    await this.listing?.devices.catch(() => {});
  }
  async list(): Promise<Device[]> {
    if (!this.listing) {
      const listing = { read: ++this.reads, devices: Promise.resolve<Device[]>([]) };
      listing.devices = this.refresh().finally(() => {
        if (this.listing === listing) this.listing = undefined;
      });
      this.listing = listing;
    }
    return this.listing.devices;
  }
  /**
   * The inventory from a read that started after this call: a read already in flight may have
   * seen the device before a boot or shutdown, so it is waited out rather than joined.
   */
  private async freshList(): Promise<Device[]> {
    const before = this.reads;
    for (;;) {
      const current = this.listing;
      if (!current) return this.list();
      if (current.read > before) return current.devices;
      await current.devices.catch(() => {});
    }
  }
  private async refresh(): Promise<Device[]> {
    if (this.closed)
      throw new DeviceError("busy", "Devices service is closed", "Reconnect to the daemon.");
    const devices = await this.options.platform.list();
    if (devices.length > 1024)
      throw new DeviceError("limit", "Device inventory limit", "Remove unused simulators or AVDs.");
    const inventory = new Map(devices.map((device) => [device.id, device]));
    for (const session of this.sessions.values()) {
      const device = inventory.get(session.device.id);
      // A boot, shutdown or rename since the last read reaches every watcher of the device.
      const changed = device !== undefined && !sameDevice(device, session.device);
      if (device) session.device = device;
      if (!inventory.has(session.device.id) || device?.state !== "booted") {
        if (session.capture) await this.stop(session);
      }
      if (changed) this.emit(session);
    }
    this.inventory.update({ devices, issues: this.options.platform.diagnostics() });
    return devices;
  }
  private async session(id: string): Promise<DeviceSession> {
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const device = (await this.list()).find((candidate) => candidate.id === id);
    if (!device)
      throw new DeviceError("not_found", "Device does not exist", "Refresh the device list.");
    // Concurrent discovery callers must share the same ownership record.
    const raced = this.sessions.get(id);
    if (raced) return raced;
    if (this.sessions.size >= 32)
      throw new DeviceError(
        "limit",
        "Device session limit",
        "Disable devices to clear idle sessions.",
      );
    const session = createSession(Device.parse(device), this.options.runtime.now);
    this.sessions.set(id, session);
    return session;
  }
  state(session: DeviceSession): DeviceState {
    return DeviceState.parse({
      device: session.device,
      enabled: this.enabled,
      approved: session.threadId !== undefined,
      threadId: session.threadId,
      lifecycle: session.lifecycle,
      streamId: session.streamId,
      ...session.lease.status(),
      error: session.error,
    });
  }
  /** Devices are on for this machine; a client with no device sessions yet needs this too. */
  isEnabled(): boolean {
    return this.enabled && !this.closed;
  }
  approvedThread(id: string): string | undefined {
    return this.sessions.get(id)?.threadId;
  }
  states(): DeviceState[] {
    return [...this.sessions.values()].map((session) => this.state(session));
  }
  watch(listener: (state: DeviceState) => void): () => void {
    if (this.listeners.size >= 64)
      throw new DeviceError(
        "limit",
        "Device state subscriber limit (64)",
        "Close another device connection before reconnecting.",
      );
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /**
   * A Devices view is open: keep the inventory current while devices are on. Release when the
   * view closes; state observers alone never cause background reads.
   */
  holdInventoryView(): () => void {
    if (this.inventoryViews >= 64)
      throw new DeviceError(
        "limit",
        "Device view limit (64)",
        "Close another Devices view before opening one.",
      );
    this.inventoryViews++;
    this.watching();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inventoryViews--;
      this.watching();
    };
  }
  /** Hear when devices are turned on or off, by any client. */
  watchEnabled(listener: (enabled: boolean) => void): () => void {
    if (this.enabledListeners.size >= 64)
      throw new DeviceError(
        "limit",
        "Device state subscriber limit (64)",
        "Close another device connection before reconnecting.",
      );
    this.enabledListeners.add(listener);
    return () => {
      this.enabledListeners.delete(listener);
    };
  }
  /** Hear about inventory changes: a simulator booting or shutting down, inside ace or not. */
  watchInventory(listener: (inventory: Inventory) => void): () => void {
    return this.inventory.watch(listener);
  }
  /** Keep reading the inventory only while devices are on and a client is watching. */
  private watching(): void {
    this.inventory.poll(this.enabled && !this.closed && this.inventoryViews > 0);
  }
  private emit(session: DeviceSession): void {
    const state = this.state(session);
    for (const listener of this.listeners) listener(state);
  }
  private authorize(session: DeviceSession, actor: Actor): void {
    if (this.closed || !this.enabled || session.changingApproval)
      throw new DeviceError(
        "permission_denied",
        "Devices are disabled",
        "Enable devices in the device panel.",
      );
    if (
      actor.kind === "agent" &&
      (actor.threadId === undefined || session.threadId !== actor.threadId)
    )
      throw new DeviceError(
        "permission_denied",
        "Device is not approved for this thread",
        "Ask the user to approve this device for the current thread.",
      );
  }
  private enqueue<T>(
    session: DeviceSession,
    actor: Actor,
    run: (authorize: () => void) => Promise<T>,
  ): Promise<T> {
    return enqueueDeviceInput(session, actor, run, this.lifecycleOwner());
  }
  async request(raw: DeviceOperation, actor: Actor): Promise<unknown> {
    const operation = DeviceOperation.parse(raw);
    try {
      return await this.perform(operation, actor);
    } catch (error) {
      const failure = deviceFailure(error);
      this.options.log?.(routine.has(failure.code) ? "info" : "warn", "Device request failed", {
        op: operation.op,
        deviceId: "deviceId" in operation ? operation.deviceId : undefined,
        actor: actor.kind,
        code: failure.code,
        permission: failure.permission,
        message: failure.message,
      });
      throw error;
    }
  }
  private async perform(operation: DeviceOperation, actor: Actor): Promise<unknown> {
    if (
      ["enable", "approve", "controller", "stream.configure", "stream.keyframe"].includes(
        operation.op,
      ) &&
      actor.kind !== "human"
    )
      throw new DeviceError(
        "permission_denied",
        "Human authorization required",
        "Ask the user to approve or delegate the device.",
      );
    if (operation.op === "enable") {
      if (this.disabling)
        throw new DeviceError("busy", "Devices are disabling", "Wait for resource cleanup.");
      const changed = this.enabled !== operation.enabled;
      this.enabled = operation.enabled;
      this.watching();
      if (changed)
        for (const listener of this.enabledListeners) {
          try {
            listener(this.enabled);
          } catch {
            /* One subscriber cannot stop the others hearing about the change. */
          }
        }
      if (!this.enabled) {
        this.disabling = true;
        try {
          await disableDeviceSessions(this.sessions.values(), this.lifecycleOwner());
          this.sessions.clear();
        } finally {
          this.disabling = false;
        }
      }
      return { enabled: this.enabled };
    }
    if (operation.op === "list") {
      const devices = await this.list();
      return {
        issues: this.options.platform.diagnostics(),
        devices:
          actor.kind === "human"
            ? devices
            : devices.filter((device) => this.sessions.get(device.id)?.threadId === actor.threadId),
      };
    }
    if (operation.op === "inventory.watch")
      throw new DeviceError(
        "not_supported",
        "Only a devices connection watches the inventory",
        "Open the Devices view.",
      );
    if (operation.op === "permissions" || operation.op === "permissions.request")
      return this.permissions(operation, actor);
    if (operation.op === "states")
      return {
        states: this.states().filter(
          (state) => actor.kind === "human" || state.threadId === actor.threadId,
        ),
        enabled: this.isEnabled(),
      };
    const viewer =
      operation.op === "stream.configure" ? this.streamOwners.scope(actor.owner) : undefined;
    const session = await this.session(operation.deviceId);
    viewer?.guard();
    if (operation.op === "approve") {
      if (!this.enabled)
        throw new DeviceError("permission_denied", "Devices are disabled", "Enable devices first.");
      await approveDevice(session, operation, this.options, this.lifecycleOwner());
      this.emit(session);
      return this.state(session);
    }
    this.authorize(session, actor);
    if (operation.op === "controller") {
      if (operation.controller === "none") session.lease.release();
      else if (operation.controller === "human") session.lease.claim(actor);
      else {
        if (!operation.threadId || !operation.agentId || session.threadId !== operation.threadId)
          throw new DeviceError(
            "permission_denied",
            "Agent must belong to approved thread",
            "Approve the thread and select an agent.",
          );
        session.lease.claim({
          kind: "agent",
          owner: agentOwner(operation.threadId, operation.agentId),
          threadId: operation.threadId,
          agentId: operation.agentId,
        });
      }
      if (session.capture?.screenSessionId && this.options.screen) {
        mirrorDeviceController(
          session,
          this.options.screen,
          (control) => this.authorize(session, control),
          () => this.emit(session),
        );
      }
      session.leaseExpiry?.();
      session.leaseExpiry = watchDeviceLease(session.lease, this.options.runtime, () => {
        try {
          if (session.capture?.screenSessionId && this.options.screen)
            this.options.screen.controller(session.capture.screenSessionId, "none");
          this.emit(session);
        } catch (error) {
          this.options.log?.("warn", "Device lease cleanup failed", { message: String(error) });
        }
      });
      this.emit(session);
      return this.state(session);
    }
    switch (operation.op) {
      case "stream.configure": {
        const result = await this.streamControlFor(session).set(actor.owner, operation.settings);
        viewer?.guard();
        return result;
      }
      case "stream.keyframe":
        await session.capture?.keyframe?.();
        return { completed: true };
      case "start":
        // A person watching a simulator needs no thread approval: they approve its window.
        if (actor.kind === "human" && session.device.platform === "ios")
          await this.options.screen?.allow(simulatorBundle);
        await this.start(session, operation.fps);
        return this.state(session);
      case "stop":
        if (actor.kind === "agent") session.lease.ticket(actor);
        await this.stop(session);
        return this.state(session);
      case "shutdown": {
        session.lease.ticket(actor);
        await this.stop(session);
        const generation = session.generation;
        await this.options.platform.shutdown(session.device, () => {
          this.authorize(session, actor);
          if (session.generation !== generation || session.lease.current())
            throw new DeviceError(
              "busy",
              "Device control changed during shutdown",
              "Take control and retry.",
            );
        });
        await this.settled();
        return { completed: true };
      }
      case "subscribe":
      case "unsubscribe":
        if (operation.op === "unsubscribe") await session.streamControl?.remove(actor.owner);
        return this.state(session);
      case "screenshot":
        return await this.screenshot(session.device.id, actor);
      case "ui.tree":
        return this.ui(session, actor, () =>
          session.capture?.screenSessionId && this.options.screen
            ? this.options.screen.uiTree(session.capture.screenSessionId, operation)
            : this.options.platform.uiTree(session.device, operation),
        );
      case "ui.find":
        return this.ui(session, actor, () =>
          session.capture?.screenSessionId && this.options.screen
            ? this.options.screen.uiFind(session.capture.screenSessionId, operation)
            : this.options.platform.uiFind(session.device, operation),
        );
      case "ui.act":
        return this.enqueue(session, actor, (guard) =>
          session.capture?.screenSessionId && this.options.screen
            ? this.options.screen.uiAct(
                session.capture.screenSessionId,
                actor.kind,
                operation,
                actor.owner,
                guard,
              )
            : this.options.platform.uiAct(session.device, operation, guard),
        );
      case "logs.start":
        await this.startLogs(session, actor);
        return { started: true };
      case "logs.stop":
        await session.logs.stop();
        return { stopped: true };
      case "logs":
        await this.startLogs(session, actor);
        return session.logs.tail(operation.limit);
      case "record.start":
        await this.record(session);
        return { started: true };
      case "record.stop": {
        const result = await stopDeviceRecording(session, actor, this.lifecycleOwner());
        await session.streamControl?.refresh();
        return result;
      }
      default: {
        const result = await this.enqueue(session, actor, (guard) =>
          performDeviceAction(this.options.platform, session, actor, operation, guard),
        );
        // Booting changes the device's state; read it now rather than at the next poll.
        if (operation.op === "boot") await this.settled();
        return result;
      }
    }
  }
  /** Read the inventory again after a lifecycle change; watchers hear the new state. */
  private async settled(): Promise<void> {
    await this.freshList();
  }
  private async permissions(
    operation: Extract<DeviceOperation, { op: "permissions" | "permissions.request" }>,
    actor: Actor,
  ): Promise<{ screenRecording: boolean; accessibility: boolean }> {
    const screen = this.options.screen;
    if (!screen)
      throw new DeviceError(
        "not_supported",
        "This daemon has no screen helper",
        "Run ace's desktop app on a Mac to view and control iOS Simulators.",
      );
    if (operation.op === "permissions") return screen.currentPermissions();
    if (actor.kind !== "human")
      throw new DeviceError(
        "permission_denied",
        "Human authorization required",
        "Ask the user to grant the permission from the device panel.",
      );
    return screen.requestPermission(operation.permission);
  }
  private async ui<T>(session: DeviceSession, actor: Actor, run: () => Promise<T>): Promise<T> {
    this.authorize(session, actor);
    const result = await run();
    this.authorize(session, actor);
    return result;
  }
  private async startLogs(session: DeviceSession, actor: Actor): Promise<void> {
    if (session.logs.running) return;
    const generation = session.generation;
    const spec = await this.options.platform.logs(session.device);
    this.authorize(session, actor);
    if (session.generation !== generation)
      throw new DeviceError("busy", "Device stopped during log startup", "Restart logs.");
    await session.logs.start(spec, this.options.env, this.options.spawnLogs);
  }
  private lifecycleOwner(): LifecycleOwner {
    return {
      log: (message, session, error) => {
        const failure = deviceFailure(error);
        this.options.log?.("warn", message, {
          deviceId: session.device.id,
          code: failure.code,
          permission: failure.permission,
          message: failure.message,
        });
      },
      enabled: () => this.enabled && !this.closed,
      sessions: () => this.sessions.values(),
      list: () => this.list(),
      emit: (session) => this.emit(session),
      failure: deviceFailure,
      authorize: (session, actor) => this.authorize(session, actor),
    };
  }
  private start(session: DeviceSession, fps: number): Promise<void> {
    return startDevice(session, fps, this.options, this.lifecycleOwner());
  }
  private stop(session: DeviceSession): Promise<void> {
    return stopDevice(session, this.lifecycleOwner());
  }
  async screenshot(id: string, actor: Actor): Promise<Frame> {
    const session = await this.session(id);
    this.authorize(session, actor);
    if (session.capture?.screenSessionId && this.options.screen) {
      const image = await this.options.screen.captureScreenshot(session.capture.screenSessionId);
      this.authorize(session, actor);
      if (session.lifecycle !== "live") throw new Error("Capture stopped during screenshot");
      return image;
    }
    if (!session.latest || session.lifecycle !== "live")
      throw new DeviceError(
        "not_found",
        "No live device frame",
        "Start the device stream and wait for its first frame.",
      );
    if (session.latest.header.codec === "h264") {
      const image = await deviceStreamSnapshot(
        session,
        this.streamControlFor(session),
        this.options.runtime,
      );
      this.authorize(session, actor);
      if (session.lifecycle !== "live") throw new Error("Device stopped during screenshot");
      return image;
    }
    return session.latest;
  }
  private streamControlFor(session: DeviceSession): DeviceStreamControl {
    session.streamControl ??= new DeviceStreamControl(async (settings) => {
      this.authorize(session, { kind: "human", owner: "capture" });
      if (session.lifecycle !== "live") throw new Error("Device stream stopped");
      return session.capture?.configure?.(settings) ?? { codec: "jpeg" };
    });
    return session.streamControl;
  }
  async subscribe(id: string, actor: Actor, sink: FrameSink): Promise<() => void> {
    const viewer = this.streamOwners.scope(actor.owner);
    const session = await this.session(id);
    viewer.guard();
    this.authorize(session, actor);
    if (session.lifecycle !== "live")
      throw new DeviceError("not_found", "Device stream is not live", "Start the stream first.");
    const epoch = session.approvalEpoch;
    const preferences = this.streamControlFor(session);
    if (!preferences.has(actor.owner)) await preferences.set(actor.owner, deviceImageStream);
    viewer.guard();
    const stop = session.hub.subscribe(async (frame) => {
      viewer.guard();
      if (session.approvalEpoch !== epoch) throw new Error("Device approval changed");
      this.authorize(session, actor);
      await sink(frame);
    }, session.latest);
    const remove = viewer.subscribe(id, () => {
      void preferences
        .remove(actor.owner)
        .catch((error) =>
          this.options.log?.("warn", "Device stream update failed", { message: String(error) }),
        );
    });
    return () => {
      stop();
      remove();
    };
  }
  async subscribeLogs(
    id: string,
    actor: Actor,
    sink: Parameters<DeviceSession["logs"]["subscribe"]>[0],
  ): Promise<() => void> {
    const session = await this.session(id);
    this.authorize(session, actor);
    const epoch = session.approvalEpoch;
    return session.logs.subscribe(async (batch) => {
      if (session.approvalEpoch !== epoch) throw new Error("Device approval changed");
      this.authorize(session, actor);
      await sink(batch);
    });
  }
  private record(session: DeviceSession): Promise<void> {
    return recordDevice(session, this.options, this.streamControlFor(session));
  }
  disconnect(owner: string): void {
    this.streamOwners.disconnect(owner);
    for (const session of this.sessions.values()) {
      void session.streamControl
        ?.remove(owner)
        .catch((error) =>
          this.options.log?.("warn", "Device stream update failed", { message: String(error) }),
        );
      if (session.lease.owned(owner)) {
        session.leaseExpiry?.();
        delete session.leaseExpiry;
        session.lease.release(owner);
        if (session.capture?.screenSessionId) this.options.screen?.releaseController(owner);
        this.emit(session);
      }
    }
  }
  async close(): Promise<void> {
    this.streamOwners.close();
    this.closed = true;
    this.enabled = false;
    this.watching();
    const results = await Promise.allSettled([
      ...[...this.sessions.values()].map(async (session) => {
        const resources = await Promise.allSettled([this.stop(session), session.logs.close()]);
        const errors = resources.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (errors.length) throw new AggregateError(errors, "Device close cleanup failed");
      }),
      this.options.platform.close(),
    ]);
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    this.sessions.clear();
    this.listeners.clear();
    this.enabledListeners.clear();
    if (errors.length) throw new AggregateError(errors, "Devices close cleanup failed");
  }
}
export function agentOwner(threadId: string, agentId: string): string {
  return JSON.stringify([threadId, agentId]);
}
export { deviceFailure } from "./failure.ts";
