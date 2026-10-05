import type { DeviceTransport } from "@ace/client/devices";
import {
  AppDevice,
  DeviceClientMessage,
  type DeviceFailure,
  type DeviceInput,
  type DeviceOperation,
  type DevicePermission,
  type DevicePermissions,
  type DeviceServerMessage,
  DeviceState,
} from "@ace/protocol/devices";
import { deviceScreens } from "./device-screens.ts";

const leaseMs = 5 * 60_000;
const width = 390;
const height = 844;

interface Session {
  device: AppDevice;
  threadId?: string;
  lifecycle: DeviceState["lifecycle"];
  streamId?: string;
  controller: DeviceState["controller"];
  leaseExpiresAt?: number;
  screen: keyof typeof deviceScreens;
  logs: string[];
}

type DeviceTransportEvents = Parameters<DeviceTransport["open"]>[0];

/** One open devices channel and the devices it watches. */
interface Channel {
  events: DeviceTransportEvents;
  streams: Set<string>;
}

class Refusal extends Error {
  readonly failure: DeviceFailure;
  constructor(
    code: DeviceFailure["code"],
    message: string,
    hint: string,
    permission?: DevicePermission,
  ) {
    super(message);
    this.failure = { code, message, hint, ...(permission ? { permission } : {}) };
  }
}

const permissionNames: Record<DevicePermission, string> = {
  screenRecording: "Screen Recording",
  accessibility: "Accessibility",
};
/** The daemon's refusal when its screen helper lacks a macOS permission. */
function denied(permission: DevicePermission): Refusal {
  const name = permissionNames[permission];
  return new Refusal(
    "permission_denied",
    `ace needs ${name} permission to ${permission === "screenRecording" ? "show the Simulator" : "send taps and keys to the Simulator"}`,
    `Open System Settings › Privacy & Security › ${name}, turn on Ace Screen Helper, then try again.`,
    permission,
  );
}

function decode(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * In-app devices as the daemon's `@ace/devices` service presents them, in memory: an iOS
 * Simulator and an Android emulator, enable, approval for a thread, boot and shutdown, a live
 * stream of JPEG screen frames in the screen binary format, an expiring human control lease,
 * input, and logs. Each `transport()` is one dedicated, already authenticated devices channel.
 * Recording, screenshots and UI trees answer `not_supported`.
 */
export class FakeAppDevices {
  private clock: () => number;
  private enabled = false;
  private sessions = new Map<string, Session>();
  private channels = new Set<Channel>();
  private sequence = 0;
  private streams = 0;
  /** Every input a person sent, in order, as the device received it. */
  readonly inputs: { deviceId: string; input: DeviceInput }[] = [];
  /** macOS permissions of the daemon's screen helper; iOS views and input need them. */
  readonly permissions: DevicePermissions = { screenRecording: true, accessibility: true };
  /** Each permission a person asked macOS for, in order. */
  readonly requested: DevicePermission[] = [];
  constructor(clock: () => number) {
    this.clock = clock;
    for (const device of [
      AppDevice.parse({
        id: "ios:7d1b2c4e-5a6f-4e8d-9b0a-1c2d3e4f5a6b",
        platform: "ios",
        name: "iPhone 16 Pro",
        state: "booted",
        runtime: "iOS 18.4",
      }),
      AppDevice.parse({
        id: "android:Pixel_9_API_35",
        platform: "android",
        name: "Pixel 9",
        state: "shutdown",
        runtime: "Android 15",
      }),
    ])
      this.sessions.set(device.id, {
        device,
        lifecycle: "idle",
        controller: "none",
        screen: "home",
        logs: [],
      });
  }

  /** Close every devices channel, as a daemon restart or a revoked token would. */
  dropAll(): void {
    // Deleting the current entry during Set iteration is safe.
    for (const channel of this.channels) {
      this.channels.delete(channel);
      channel.events.close();
    }
  }

  /** The thread a device is approved for, as tests check what a person allowed. */
  approval(deviceId: string): string | undefined {
    return this.sessions.get(deviceId)?.threadId;
  }

  /** One authenticated devices channel, as `deviceTransport()` opens against a real daemon. */
  transport(): DeviceTransport {
    let channel: Channel | undefined;
    return {
      open: (events) => {
        const opened: Channel = { events, streams: new Set<string>() };
        channel = opened;
        this.channels.add(opened);
        queueMicrotask(() => {
          if (channel === opened) events.ready();
        });
      },
      send: (raw) => {
        const current = channel;
        if (!current) throw new Error("Device channel is not authenticated");
        const message = DeviceClientMessage.parse(raw);
        queueMicrotask(() => this.receive(current, message));
      },
      close: () => {
        if (channel) this.channels.delete(channel);
        const closed = channel;
        channel = undefined;
        // Disconnecting releases a human's control, as the daemon does.
        if (closed)
          for (const session of this.sessions.values())
            if (session.controller === "human") {
              session.controller = "none";
              delete session.leaseExpiresAt;
              this.publish(session);
            }
      },
    };
  }

  private state(session: Session): DeviceState {
    return DeviceState.parse({
      device: session.device,
      enabled: this.enabled,
      approved: session.threadId !== undefined,
      ...(session.threadId ? { threadId: session.threadId } : {}),
      lifecycle: session.lifecycle,
      ...(session.streamId ? { streamId: session.streamId } : {}),
      controller: session.controller,
      ...(session.leaseExpiresAt ? { leaseExpiresAt: session.leaseExpiresAt } : {}),
    });
  }

  private send(channel: Channel, message: DeviceServerMessage): void {
    if (this.channels.has(channel)) channel.events.message(message);
  }

  private publish(session: Session): void {
    for (const channel of this.channels)
      this.send(channel, { type: "devices.state", state: this.state(session) });
  }

  private frame(session: Session): Uint8Array {
    const payload = decode(deviceScreens[session.screen]);
    const header = new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        sessionId: session.streamId,
        sequence: ++this.sequence,
        timestamp: this.clock(),
        width,
        height,
        codec: "jpeg",
        scale: 1,
        bytes: payload.byteLength,
      }),
    );
    const packet = new Uint8Array(4 + header.byteLength + payload.byteLength);
    new DataView(packet.buffer).setUint32(0, header.byteLength);
    packet.set(header, 4);
    packet.set(payload, 4 + header.byteLength);
    return packet;
  }

  private paint(session: Session): void {
    if (session.lifecycle !== "live") return;
    for (const channel of this.channels)
      if (channel.streams.has(session.device.id)) channel.events.message(this.frame(session));
  }

  private log(session: Session, line: string, channel?: Channel): void {
    const stamped = `${new Date(this.clock()).toISOString().slice(11, 19)} ${line}`;
    session.logs = [...session.logs, stamped].slice(-256);
    for (const target of channel ? [channel] : this.channels)
      this.send(target, {
        type: "devices.logs",
        deviceId: session.device.id,
        sequence: session.logs.length,
        lines: [stamped],
        dropped: 0,
      });
  }

  private session(id: string): Session {
    const session = this.sessions.get(id);
    if (!session)
      throw new Refusal("not_found", "Device does not exist", "Refresh the device list.");
    if (!this.enabled)
      throw new Refusal("permission_denied", "Devices are disabled", "Enable devices first.");
    return session;
  }

  private controlled(session: Session): void {
    if (session.controller !== "human" || (session.leaseExpiresAt ?? 0) <= this.clock())
      throw new Refusal("lease_required", "Take control of the device first", "Take control.");
  }

  private receive(channel: Channel, message: DeviceClientMessage): void {
    let data: unknown;
    try {
      data = this.operate(channel, message.operation);
    } catch (error) {
      const failure =
        error instanceof Refusal
          ? error.failure
          : { code: "command_failed" as const, message: "Device request failed", hint: "" };
      this.send(channel, {
        type: "devices.result",
        requestId: message.requestId,
        ok: false,
        error: failure,
      });
      return;
    }
    this.send(channel, { type: "devices.result", requestId: message.requestId, ok: true, data });
  }

  private operate(channel: Channel, operation: DeviceOperation): unknown {
    if (operation.op === "inventory.watch") return { watching: operation.watching };
    if (operation.op === "enable") {
      this.enabled = operation.enabled;
      for (const open of this.channels)
        this.send(open, { type: "devices.enabled", enabled: this.enabled });
      if (!this.enabled)
        for (const session of this.sessions.values()) {
          delete session.threadId;
          delete session.streamId;
          delete session.leaseExpiresAt;
          session.lifecycle = "idle";
          session.controller = "none";
        }
      return { enabled: this.enabled };
    }
    if (operation.op === "list")
      return { devices: [...this.sessions.values()].map((s) => s.device), issues: [] };
    if (operation.op === "states")
      return {
        states: this.enabled ? [...this.sessions.values()].map((s) => this.state(s)) : [],
        enabled: this.enabled,
      };
    if (operation.op === "permissions") return { ...this.permissions };
    if (operation.op === "permissions.request") {
      this.requested.push(operation.permission);
      return { ...this.permissions };
    }
    const session = this.session(operation.deviceId);
    switch (operation.op) {
      case "approve":
        if (operation.allowed) session.threadId = operation.threadId;
        else delete session.threadId;
        this.publish(session);
        return this.state(session);
      case "controller":
        if (operation.controller === "human") {
          session.controller = "human";
          session.leaseExpiresAt = this.clock() + leaseMs;
        } else if (operation.controller === "none") {
          session.controller = "none";
          delete session.leaseExpiresAt;
        } else {
          if (!operation.threadId || session.threadId !== operation.threadId)
            throw new Refusal(
              "permission_denied",
              "Agent must belong to approved thread",
              "Approve the thread and select an agent.",
            );
          session.controller = "agent";
          delete session.leaseExpiresAt;
        }
        this.publish(session);
        return this.state(session);
      case "boot":
        this.controlled(session);
        session.device = { ...session.device, state: "booted" };
        this.log(session, `${session.device.name} booted`);
        this.publish(session);
        return { completed: true };
      case "shutdown":
        this.controlled(session);
        session.device = { ...session.device, state: "shutdown" };
        session.lifecycle = "idle";
        delete session.streamId;
        this.publish(session);
        return { completed: true };
      case "start":
        if (session.device.state !== "booted")
          throw new Refusal("not_booted", "The device isn't running", "Boot it first.");
        if (session.device.platform === "ios" && !this.permissions.screenRecording)
          throw denied("screenRecording");
        session.lifecycle = "live";
        session.streamId = `stream-${++this.streams}`;
        this.publish(session);
        this.paint(session);
        return this.state(session);
      case "stop":
        session.lifecycle = "idle";
        delete session.streamId;
        this.publish(session);
        return this.state(session);
      case "subscribe":
        channel.streams.add(session.device.id);
        if (session.lifecycle === "live") channel.events.message(this.frame(session));
        return this.state(session);
      case "unsubscribe":
        channel.streams.delete(session.device.id);
        return this.state(session);
      case "input":
        this.controlled(session);
        if (session.device.platform === "ios" && !this.permissions.accessibility)
          throw denied("accessibility");
        this.inputs.push({ deviceId: session.device.id, input: operation.input });
        if (operation.input.kind === "key" && operation.input.key === "home")
          session.screen = "home";
        else if (operation.input.kind === "tap") session.screen = "app";
        this.log(session, `input ${operation.input.kind}`);
        this.paint(session);
        return { completed: true };
      case "open_app":
      case "open_url":
      case "install":
      case "configure":
        this.controlled(session);
        return { completed: true };
      case "logs.start":
        for (const line of session.logs.length
          ? []
          : ["SpringBoard launched", "Network reachable via en0"])
          this.log(session, line, channel);
        return { started: true };
      case "logs.stop":
        return { stopped: true };
      case "logs":
        return { lines: session.logs.slice(-operation.limit), dropped: 0 };
      default:
        throw new Refusal(
          "not_supported",
          "Not available on this simulated device",
          "Connect to your daemon to use it.",
        );
    }
  }
}
