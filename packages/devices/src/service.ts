import {
  type Frame,
  type FrameSink,
  type ScreenManager,
  type RecordingArtifact,
} from "@ace/screen";
import {
  AppDevice as Device,
  DeviceOperation,
  DeviceState,
  DeviceFailure,
} from "@ace/protocol/devices";
import { DevicePlatform } from "./platform.ts";
import { DeviceError } from "./sdk.ts";
import type { startCapture } from "./capture.ts";
import { startDevice, stopDevice, recordDevice, type LifecycleOwner } from "./lifecycle.ts";
import { createSession, type DeviceSession } from "./session.ts";
import type { Actor } from "./lease.ts";
import type { DeviceRuntime } from "./runtime.ts";
import { performDeviceAction } from "./actions.ts";
import { mirrorDeviceController } from "./screen-controller.ts";

export interface DevicesOptions {
  platform: DevicePlatform;
  runtime: DeviceRuntime;
  screen?: ScreenManager;
  env: NodeJS.ProcessEnv;
  recordingDirectory: string;
  publishArtifact(
    artifact: RecordingArtifact,
    threadId: string,
  ): Promise<{ id: string; bytes: number; mimeType: string } | void>;
  recordingAvailable?(): boolean;
  capture?: typeof startCapture;
}
export class DevicesService {
  private enabled = false;
  private closed = false;
  private readonly sessions = new Map<string, DeviceSession>();
  private readonly listeners = new Set<(state: DeviceState) => void>();
  private readonly options: DevicesOptions;
  private listing: Promise<Device[]> | undefined;
  constructor(options: DevicesOptions) {
    this.options = options;
  }
  async list(): Promise<Device[]> {
    this.listing ??= this.refresh().finally(() => {
      this.listing = undefined;
    });
    return this.listing;
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
      if (device) session.device = device;
      if (!inventory.has(session.device.id) || device?.state !== "booted") {
        if (session.capture) await this.stop(session);
      }
    }
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
  states(): DeviceState[] {
    return [...this.sessions.values()].map((session) => this.state(session));
  }
  watch(listener: (state: DeviceState) => void): () => void {
    if (this.listeners.size >= 64) throw new Error("Device state subscriber limit");
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit(session: DeviceSession): void {
    const state = this.state(session);
    for (const listener of this.listeners) listener(state);
  }
  private authorize(session: DeviceSession, actor: Actor): void {
    if (this.closed || !this.enabled)
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
    this.authorize(session, actor);
    const ticket = session.lease.ticket(actor);
    if (session.pending >= 32)
      throw new DeviceError(
        "busy",
        "Device input queue is full",
        "Wait for pending device actions.",
      );
    session.pending++;
    const next = session.tail
      .then(async () => {
        this.authorize(session, actor);
        session.lease.assert(actor, ticket);
        const guard = () => {
          this.authorize(session, actor);
          session.lease.assert(actor, ticket);
        };
        const result = await run(guard);
        this.authorize(session, actor);
        session.lease.assert(actor, ticket);
        this.emit(session);
        return result;
      })
      .finally(() => {
        session.pending--;
      });
    session.tail = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  async request(raw: DeviceOperation, actor: Actor): Promise<unknown> {
    const operation = DeviceOperation.parse(raw);
    if (["enable", "approve", "controller"].includes(operation.op) && actor.kind !== "human")
      throw new DeviceError(
        "permission_denied",
        "Human authorization required",
        "Ask the user to approve or delegate the device.",
      );
    if (operation.op === "enable") {
      this.enabled = operation.enabled;
      if (!this.enabled) {
        await Promise.all(
          [...this.sessions.values()].map(async (session) => {
            delete session.threadId;
            await this.stop(session);
            await session.logs.close();
          }),
        );
        this.sessions.clear();
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
    if (operation.op === "states")
      return {
        states: this.states().filter(
          (state) => actor.kind === "human" || state.threadId === actor.threadId,
        ),
      };
    const session = await this.session(operation.deviceId);
    if (operation.op === "approve") {
      if (!this.enabled)
        throw new DeviceError("permission_denied", "Devices are disabled", "Enable devices first.");
      await this.stop(session);
      if (operation.allowed) {
        // This is a human approval operation. Agents never reach this branch.
        if (session.device.platform === "ios" && this.options.screen) {
          await this.options.screen.enable(true);
          await this.options.screen.approve("com.apple.iphonesimulator", true);
        }
        session.threadId = operation.threadId;
      } else delete session.threadId;
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
      this.emit(session);
      return this.state(session);
    }
    switch (operation.op) {
      case "start":
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
        return { completed: true };
      }
      case "subscribe":
      case "unsubscribe":
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
        const recording = session.recording ?? session.completed;
        if (!recording)
          throw new DeviceError("not_found", "No recording", "Start recording first.");
        delete session.recording;
        const artifact = await recording.stop();
        return (
          session.recordingArtifact ?? {
            id: artifact.id,
            bytes: artifact.bytes,
            mimeType: artifact.mimeType,
          }
        );
      }
      default:
        return this.enqueue(session, actor, (guard) =>
          performDeviceAction(this.options.platform, session, actor, operation, guard),
        );
    }
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
    await session.logs.start(spec, this.options.env);
  }
  private lifecycleOwner(): LifecycleOwner {
    return {
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
      await this.options.screen.captureScreenshot(session.capture.screenSessionId);
      this.authorize(session, actor);
    }
    if (!session.latest || session.lifecycle !== "live")
      throw new DeviceError(
        "not_found",
        "No live device frame",
        "Start the device stream and wait for its first frame.",
      );
    return session.latest;
  }
  async subscribe(id: string, actor: Actor, sink: FrameSink): Promise<() => void> {
    const session = await this.session(id);
    this.authorize(session, actor);
    if (session.lifecycle !== "live")
      throw new DeviceError("not_found", "Device stream is not live", "Start the stream first.");
    return session.hub.subscribe(async (frame) => {
      this.authorize(session, actor);
      await sink(frame);
    }, session.latest);
  }
  async subscribeLogs(
    id: string,
    actor: Actor,
    sink: Parameters<DeviceSession["logs"]["subscribe"]>[0],
  ): Promise<() => void> {
    const session = await this.session(id);
    this.authorize(session, actor);
    return session.logs.subscribe(async (batch) => {
      this.authorize(session, actor);
      await sink(batch);
    });
  }
  private record(session: DeviceSession): Promise<void> {
    return recordDevice(session, this.options);
  }
  disconnect(owner: string): void {
    for (const session of this.sessions.values()) {
      if (session.lease.owned(owner)) {
        session.lease.release(owner);
        if (session.capture?.screenSessionId) this.options.screen?.releaseController(owner);
        this.emit(session);
      }
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    this.enabled = false;
    await Promise.all([...this.sessions.values()].map((session) => this.stop(session)));
    await this.options.platform.close();
    this.sessions.clear();
    this.listeners.clear();
  }
}
export function agentOwner(threadId: string, agentId: string): string {
  return JSON.stringify([threadId, agentId]);
}
export function deviceFailure(error: unknown): DeviceFailure {
  return error instanceof DeviceError
    ? DeviceFailure.parse({
        code: error.code,
        message: error.message.slice(0, 2048),
        hint: error.hint.slice(0, 2048),
      })
    : {
        code: "command_failed",
        message: error instanceof Error ? error.message.slice(0, 2048) : "Device operation failed",
        hint: "Check installed tools and device state, then retry.",
      };
}
