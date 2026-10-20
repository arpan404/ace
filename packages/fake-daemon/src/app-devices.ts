import type { DeviceTransport } from "@ace/client/devices";
import {
  AppDevice,
  type DeviceActivity,
  DeviceAck,
  DeviceClientMessage,
  type DeviceFailure,
  type DeviceInput,
  type DeviceOperation,
  type DevicePermission,
  type DevicePermissions,
  type DeviceServerMessage,
  DeviceState,
} from "@ace/protocol/devices";
import { fakeDeviceFrame, fakePictureBytes } from "./screen-frame.ts";
import { fakeDeviceUITree } from "./device-ui-tree.ts";

const leaseMs = 5 * 60_000;

type StreamSettings = Extract<DeviceOperation, { op: "stream.configure" }>["settings"];

interface Session {
  device: AppDevice;
  threadId?: string;
  lifecycle: DeviceState["lifecycle"];
  streamId?: string;
  /** What the capture makes: JPEG for agents until a viewer arrives, then H.264. */
  codec: "jpeg" | "h264";
  /** The next H.264 frame is a keyframe: after a (re)configure, a new stream or a request. */
  keyframe: boolean;
  controller: DeviceState["controller"];
  humanOwner?: Channel;
  holder?: DeviceState["holder"];
  leaseExpiresAt?: number;
  screen: "home" | "app";
  logs: string[];
  recording?: boolean;
  /** The last thing an agent did here, numbered from `activitySequence`. */
  activity?: DeviceActivity;
  activitySequence: number;
}

function idleSession(device: AppDevice): Session {
  return {
    device,
    lifecycle: "idle",
    controller: "none",
    screen: "home",
    logs: [],
    codec: "jpeg",
    keyframe: true,
    activitySequence: 0,
  };
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
/** The daemon's refusal of a live view whose capture can only make JPEG. */
function noVideo(): Refusal {
  return new Refusal(
    "tool_missing",
    "This Mac's screen helper can't stream video for the Simulator live view",
    "Install serve-sim 0.1.48 for the live view: npm install -g serve-sim@0.1.48",
  );
}
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

/**
 * In-app devices as the daemon's `@ace/devices` service presents them, in memory: an iOS
 * Simulator and an Android emulator, enable, approval for a thread, boot and shutdown, a live
 * view on the shared media stream (H.264 only, refused when `videoEncoding` is off; JPEG only for
 * screenshots), an expiring human control lease, input, and logs. Each `transport()`
 * is one dedicated, already authenticated devices channel.
 * UI trees are a fixed Settings screen; UI find and act answer `not_supported`.
 */
export class FakeAppDevices {
  onRecording?: (threadId: string, artifactId: string) => void;
  logsFail = false;
  readonly actions: DeviceOperation[] = [];
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
  /**
   * Whether the capture can stream H.264, as serve-sim always does. On, viewers get a real IDR
   * of the screen for every picture. Off, a live view is refused with the daemon's serve-sim
   * hint, as on a Mac whose screen helper can only make JPEG.
   */
  videoEncoding = true;
  /** Every `devices.ack` a viewer sent, in order. */
  readonly acks: DeviceAck[] = [];
  private messageIds = 0;
  /** Every live-view setting a viewer asked for, in order. */
  readonly streamRequests: { deviceId: string; settings: StreamSettings }[] = [];
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
      this.sessions.set(device.id, idleSession(device));
  }

  /** Close every devices channel, as a daemon restart or a revoked token would. */
  dropAll(): void {
    // Deleting the current entry during Set iteration is safe.
    for (const channel of this.channels) {
      this.channels.delete(channel);
      channel.events.close();
    }
  }

  /** The thread whose agent or person took a device last. */
  boundThread(deviceId: string): string | undefined {
    return this.sessions.get(deviceId)?.threadId;
  }

  /** Another device joins the inventory, idle and uncontrolled, and open channels hear of it. */
  addDevice(device: AppDevice): void {
    const parsed = AppDevice.parse(device);
    if (this.sessions.has(parsed.id)) throw new Error(`Device ${parsed.id} already exists`);
    this.sessions.set(parsed.id, idleSession(parsed));
    const devices = [...this.sessions.values()].map((session) => session.device);
    for (const channel of this.channels)
      this.send(channel, { type: "devices.inventory", devices, issues: [] });
  }

  /** A thread's agent takes a device, as the daemon's claim for an agent does. */
  agentTakes(deviceId: string, threadId: string, agentId: string): void {
    const session = this.known(deviceId);
    session.threadId = threadId;
    session.controller = "agent";
    delete session.humanOwner;
    session.holder = DeviceState.shape.holder.unwrap().parse({ threadId, agentId });
    delete session.leaseExpiresAt;
    this.publish(session);
  }

  /** The agent holding a device acted on it: viewers see the action, numbered, and a new frame. */
  agentActs(deviceId: string, activity: Omit<DeviceActivity, "sequence">): void {
    const session = this.known(deviceId);
    session.activitySequence++;
    session.activity = { ...activity, sequence: session.activitySequence };
    if (activity.action === "key" && activity.key === "home") session.screen = "home";
    else if (activity.point) session.screen = "app";
    this.publish(session);
    this.paint(session);
  }

  private known(deviceId: string): Session {
    const session = this.sessions.get(deviceId);
    if (!session) throw new Error(`Unknown device ${deviceId}`);
    return session;
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
        if (raw.type === "devices.ack") {
          const ack = DeviceAck.parse(raw);
          this.acks.push(ack);
          // A decoder that lost its place gets a fresh picture, as the daemon's window sends.
          const session = this.sessions.get(ack.deviceId);
          if (ack.keyframe && session)
            queueMicrotask(() => {
              session.keyframe = true;
              this.paint(session);
            });
          return;
        }
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
            if (session.controller === "human" && session.humanOwner === closed) {
              session.controller = "none";
              delete session.humanOwner;
              delete session.holder;
              delete session.leaseExpiresAt;
              this.publish(session);
            }
      },
    };
  }

  private state(session: Session, channel: Channel): DeviceState {
    return DeviceState.parse({
      device: session.device,
      enabled: this.enabled,
      ...(session.threadId ? { threadId: session.threadId } : {}),
      lifecycle: session.lifecycle,
      recording: session.recording === true,
      ...(session.streamId ? { streamId: session.streamId } : {}),
      // The emulator's live view takes several fingers, as scrcpy's does; the Simulator's says
      // nothing, as an older daemon's doesn't.
      ...(session.lifecycle === "live" && session.device.platform === "android"
        ? { touch: "multi" as const }
        : {}),
      controller: session.controller,
      ownedHere:
        session.controller === "human" &&
        session.humanOwner === channel &&
        (session.leaseExpiresAt ?? 0) > this.clock(),
      holder: session.holder,
      ...(session.leaseExpiresAt ? { leaseExpiresAt: session.leaseExpiresAt } : {}),
      ...(session.activity ? { activity: session.activity } : {}),
    });
  }

  private send(channel: Channel, message: DeviceServerMessage): void {
    if (this.channels.has(channel)) channel.events.message(message);
  }

  private publish(session: Session): void {
    for (const channel of this.channels)
      this.send(channel, { type: "devices.state", state: this.state(session, channel) });
  }

  private nextMessageId(): number {
    this.messageIds = (this.messageIds + 1) >>> 0;
    return this.messageIds;
  }

  /** One picture to `viewers`, as stream kind `deviceFrame` pieces. */
  private show(session: Session, viewers: readonly Channel[]): void {
    const pieces = fakeDeviceFrame({
      deviceId: session.device.id,
      sessionId: session.streamId ?? "idle",
      sequence: ++this.sequence,
      timestamp: this.clock(),
      screen: session.screen,
      codec: session.codec,
      keyframe: session.keyframe,
      id: this.nextMessageId(),
    });
    session.keyframe = false;
    for (const channel of viewers) for (const piece of pieces) channel.events.message(piece);
  }

  /** A new picture for the device's viewers; live views only ever get video. */
  private paint(session: Session): void {
    if (session.lifecycle !== "live" || session.codec !== "h264") return;
    const viewers = [...this.channels].filter((channel) => channel.streams.has(session.device.id));
    if (viewers.length) this.show(session, viewers);
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

  private controlled(session: Session, channel: Channel): void {
    if (
      session.controller !== "human" ||
      session.humanOwner !== channel ||
      (session.leaseExpiresAt ?? 0) <= this.clock()
    )
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
          session.recording = false;
          delete session.streamId;
          delete session.leaseExpiresAt;
          session.lifecycle = "idle";
          session.controller = "none";
          delete session.humanOwner;
          delete session.holder;
        }
      return { enabled: this.enabled };
    }
    if (operation.op === "list")
      return { devices: [...this.sessions.values()].map((s) => s.device), issues: [] };
    if (operation.op === "states")
      return {
        states: this.enabled ? [...this.sessions.values()].map((s) => this.state(s, channel)) : [],
        enabled: this.enabled,
      };
    if (operation.op === "permissions") return { ...this.permissions };
    if (operation.op === "permissions.request") {
      this.requested.push(operation.permission);
      return { ...this.permissions };
    }
    const session = this.session(operation.deviceId);
    switch (operation.op) {
      case "controller":
        if (operation.controller === "human") {
          if (operation.threadId) session.threadId = operation.threadId;
          session.controller = "human";
          session.humanOwner = channel;
          delete session.holder;
          session.leaseExpiresAt = this.clock() + leaseMs;
        } else if (operation.controller === "none") {
          session.controller = "none";
          delete session.humanOwner;
          delete session.holder;
          delete session.leaseExpiresAt;
        } else {
          if (!operation.threadId || !operation.agentId)
            throw new Refusal(
              "permission_denied",
              "Agent and thread required",
              "Select one of the thread's agents.",
            );
          // Handing the device to a thread's agent moves the device to that thread.
          session.threadId = operation.threadId;
          session.controller = "agent";
          delete session.humanOwner;
          session.holder = { threadId: operation.threadId, agentId: operation.agentId };
          delete session.leaseExpiresAt;
        }
        this.publish(session);
        return this.state(session, channel);
      case "boot":
        this.controlled(session, channel);
        session.device = { ...session.device, state: "booted" };
        this.log(session, `${session.device.name} booted`);
        this.publish(session);
        return { completed: true };
      case "shutdown":
        this.controlled(session, channel);
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
        session.codec = "jpeg";
        session.keyframe = true;
        this.publish(session);
        this.paint(session);
        return this.state(session, channel);
      case "stop":
        session.lifecycle = "idle";
        delete session.streamId;
        this.publish(session);
        return this.state(session, channel);
      case "subscribe":
        // A viewer's arrival switches the capture to video; one that can't make it is refused.
        if (session.lifecycle === "live" && !this.videoEncoding) throw noVideo();
        channel.streams.add(session.device.id);
        session.codec = "h264";
        // A new viewer starts from a self-contained frame.
        session.keyframe = true;
        if (session.lifecycle === "live") this.show(session, [channel]);
        return this.state(session, channel);
      case "stream.configure": {
        this.streamRequests.push({ deviceId: session.device.id, settings: operation.settings });
        if (operation.settings.codec !== "h264")
          throw new Refusal(
            "not_supported",
            "Device live views are H.264 video only",
            "Update ace on this device; live views no longer stream JPEG.",
          );
        if (!this.videoEncoding) throw noVideo();
        if (session.codec !== "h264") {
          session.codec = "h264";
          session.keyframe = true;
          this.paint(session);
        }
        return { codec: "h264" };
      }
      case "stream.keyframe":
        session.keyframe = true;
        this.paint(session);
        return { completed: true };
      case "unsubscribe":
        channel.streams.delete(session.device.id);
        return this.state(session, channel);
      case "input":
        this.controlled(session, channel);
        if (session.device.platform === "ios" && !this.permissions.accessibility)
          throw denied("accessibility");
        this.inputs.push({ deviceId: session.device.id, input: operation.input });
        if (operation.input.kind === "key" && operation.input.key === "home")
          session.screen = "home";
        else if (
          operation.input.kind === "tap" ||
          (operation.input.kind === "pointer" && operation.input.phase === "up")
        )
          session.screen = "app";
        this.log(session, `input ${operation.input.kind}`);
        this.paint(session);
        return { completed: true };
      case "open_app":
      case "open_url":
      case "install":
      case "configure":
        this.controlled(session, channel);
        this.actions.push(operation);
        return { completed: true };
      case "screenshot": {
        // A still JPEG on the media stream first; the result names it.
        const streamId = session.streamId ?? "idle";
        const sequence = ++this.sequence;
        for (const piece of fakeDeviceFrame({
          deviceId: session.device.id,
          sessionId: streamId,
          sequence,
          timestamp: this.clock(),
          screen: session.screen,
          still: true,
          id: this.nextMessageId(),
        }))
          channel.events.message(piece);
        return {
          streamId,
          sequence,
          width: 390,
          height: 844,
          bytes: fakePictureBytes(session.screen).length,
        };
      }
      case "record.start":
        if (!session.threadId)
          throw new Refusal(
            "permission_denied",
            "No thread is using this device",
            "Take control of it in a thread first.",
          );
        session.recording = true;
        this.publish(session);
        return { started: true };
      case "record.stop": {
        if (!session.recording || !session.threadId)
          throw new Refusal("not_found", "No recording", "Start recording first.");
        session.recording = false;
        this.publish(session);
        const artifactId = `device-recording-${++this.streams}`;
        this.onRecording?.(session.threadId, artifactId);
        return { id: artifactId, bytes: 8, mimeType: "video/mp4" };
      }
      case "logs.start":
        if (this.logsFail) throw new Refusal("command_failed", "Logs couldn't start", "Retry.");
        for (const line of session.logs.length
          ? []
          : ["SpringBoard launched", "Network reachable via en0"])
          this.log(session, line, channel);
        return { started: true };
      case "logs.stop":
        return { stopped: true };
      case "logs":
        return { lines: session.logs.slice(-operation.limit), dropped: 0 };
      case "ui.tree":
        return fakeDeviceUITree;
      default:
        throw new Refusal(
          "not_supported",
          "Not available on this simulated device",
          "Connect to your daemon to use it.",
        );
    }
  }
}
