import { facts, type FakeDaemon } from "@ace/fake-daemon";
import {
  AppDevice,
  ClientMessage,
  DeviceAck,
  DeviceClientMessage,
  ScreenAck,
  DeviceState,
  ScreenClientMessage,
  ThreadId,
} from "@ace/protocol";
import { z } from "zod";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { DeviceChromeReader, deviceChromeSources } from "@ace/devices";

const DeviceStateMessage = z.object({ type: z.literal("devices.state"), state: DeviceState });
import type { ServerWebSocket } from "bun";

/*
 * Devices for the phone's fixture: the fake daemon's in-memory simulators and emulators (no real
 * Simulator or emulator ever starts), served on the dedicated devices and screen channels the
 * app opens beside its main socket, and a thread whose Claude agent is using an iPhone, acting
 * on it every few seconds so the device screen shows its actions.
 */

const iphone = "ios:7d1b2c4e-5a6f-4e8d-9b0a-1c2d3e4f5a6b";
export const devicesThread = "ios-devices";

type Socket = ServerWebSocket<undefined>;
interface Feature {
  send(message: unknown): unknown;
  close(): void;
}
const features = new Map<Socket, Feature>();

/** More devices than the fake daemon's two, so the list and Start sheet have kinds to show. */
function seedDevices(daemon: FakeDaemon): void {
  for (const device of [
    { id: "ios:2b9f6c1d-0a4e-4f7b-8c3d-5e6f7a8b9c0d", name: "iPhone 17", state: "shutdown" },
    {
      id: "ios:3c8e5b2a-1f4d-4e6c-9b2a-6d7e8f9a0b1c",
      name: "iPad Pro 13-inch (M5)",
      state: "shutdown",
    },
    {
      id: "ios:4d7c4a3b-2e5c-4d5b-8a1f-7c8d9e0f1a2b",
      name: "iPhone SE (3rd generation)",
      state: "shutdown",
    },
  ] as const)
    daemon.appDevices.addDevice(
      AppDevice.parse({ ...device, platform: "ios", runtime: "iOS 26.0" }),
    );
  // A foldable iPhone, booted and open flat, for the posture control.
  const duo = "ios:5e6d3b4c-3f6d-4e5c-9b2a-8d9e0f1a2b3c";
  daemon.appDevices.addDevice(
    AppDevice.parse({
      id: duo,
      name: "iPhone Duo",
      state: "booted",
      platform: "ios",
      runtime: "iOS 27.1",
    }),
  );
  daemon.appDevices.folds.set(duo, "open");
}

/** One of ace's simulator tools on the iPhone, as the agent called it. */
const sim = (item: string, tool: string, args: object) =>
  facts.tool("root", item, {
    kind: "mcp",
    title: tool,
    detail: { kind: "mcp", server: "ace", tool, arguments: { simId: iphone, ...args } },
  });

/** The thread whose agent drives the iPhone, with the steps that started and used it. */
function seedThread(daemon: FakeDaemon, details: (branch: string) => object): string {
  daemon.createThread({
    hasSentMessage: true,
    id: devicesThread,
    workspaceId: "ace",
    title: "Check sign-in on iPhone",
    provider: "claude",
    details: details("fix/sign-in-keyboard"),
  });
  daemon.apply(devicesThread, [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Check the sign-in screen on the iPhone simulator."),
    sim("start", "sim_start", {}),
    facts.toolDone("root", "start"),
    sim("ui", "sim_ui", {}),
    facts.toolDone("root", "ui"),
    sim("tap", "sim_act", { action: "tap", ref: "e7" }),
  ]);
  const view = daemon.snapshot({ kind: "thread", threadId: ThreadId.parse(devicesThread) });
  const root = view?.kind === "thread" ? Object.keys(view.agents)[0] : undefined;
  if (!root) throw new Error("The devices thread has no agent");
  return root;
}

/** Turn devices on, give the iPhone to the thread's agent and keep it acting. */
/** A process's output, for reading Xcode's device profiles. */
const output = (command: string, args: readonly string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile(command, [...args], { maxBuffer: 4 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    ),
  );

/**
 * The fake iPhone wears the real iPhone 16 Pro body from this Mac's Xcode, read and drawn by the
 * daemon's own reader, so the phone shows what a real daemon sends. Off a Mac, or without
 * Xcode's files, it keeps the drawn frame.
 */
async function seedChrome(daemon: FakeDaemon): Promise<void> {
  if (process.platform !== "darwin") return;
  const reader = new DeviceChromeReader(
    deviceChromeSources({
      home: homedir(),
      env: process.env,
      simctl: (args) => output("xcrun", ["simctl", ...args]),
      plutil: (args) => output("/usr/bin/plutil", args),
      simulatorType: async () => undefined,
    }),
  );
  const chrome = await reader
    .chrome(
      AppDevice.parse({
        id: iphone,
        platform: "ios",
        name: "iPhone 16 Pro",
        state: "booted",
        model: "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro",
      }),
      "png",
    )
    .catch(() => undefined);
  if (chrome) daemon.appDevices.chromes.set(iphone, chrome);
}

export function spikeDevices(daemon: FakeDaemon, details: (branch: string) => object): void {
  seedDevices(daemon);
  void seedChrome(daemon);
  const agentId = seedThread(daemon, details);
  const owner = daemon.appDevices.transport();
  // The agent acts only while it holds the iPhone: a person who took over sees no actions.
  let agentHolds = false;
  owner.open({
    ready: () => {},
    message: (message: unknown) => {
      const update = DeviceStateMessage.safeParse(message);
      if (update.success && update.data.state.device.id === iphone)
        agentHolds = update.data.state.controller === "agent";
    },
    close: () => {},
  });
  queueMicrotask(() =>
    owner.send(
      DeviceClientMessage.parse({
        type: "devices.request",
        requestId: "spike-enable",
        operation: { op: "enable", enabled: true },
      }),
    ),
  );
  setTimeout(() => daemon.appDevices.agentTakes(iphone, devicesThread, agentId), 50);
  const actions = [
    { action: "press", ref: "e7", label: "Sign in", point: { x: 196, y: 640 } },
    { action: "type" },
    { action: "swipe", point: { x: 196, y: 700 }, to: { x: 196, y: 300 } },
    { action: "key", key: "home" },
  ];
  let next = 0;
  setInterval(() => {
    const activity = actions[next++ % actions.length];
    if (activity && agentHolds) daemon.appDevices.agentActs(iphone, activity);
  }, 4_000);
  seedScreen(daemon, agentId);
}

/** Computer use on, with the thread's agent using Safari, as Mac screens show it. */
function seedScreen(daemon: FakeDaemon, agentId: string): void {
  daemon.screen.enable(true);
  const screen = daemon.screen.transport();
  const Result = z.object({
    type: z.literal("screen.result"),
    requestId: z.literal("spike-share"),
    data: z.object({ sessionId: z.string() }),
  });
  const request = (requestId: string, operation: unknown) =>
    void screen.send(ScreenClientMessage.parse({ type: "screen.request", requestId, operation }));
  screen.open({
    ready: () => {
      request("spike-share", {
        op: "start",
        target: { kind: "app", bundleId: "com.apple.Safari" },
        threadId: devicesThread,
      });
    },
    message: (message: unknown) => {
      const started = Result.safeParse(message);
      if (started.success)
        request("spike-agent", {
          op: "controller",
          sessionId: started.data.data.sessionId,
          controller: "agent",
          threadId: devicesThread,
          agentId,
        });
    },
    close: () => {},
  });
}

/**
 * A socket whose hello names the devices or screen channel is that channel's, not the main
 * one's. Returns true when the message was a feature channel's.
 */
export function featureMessage(
  daemon: FakeDaemon,
  socket: Socket,
  data: string,
  main: Map<Socket, unknown>,
): boolean {
  const open = features.get(socket);
  if (open) {
    const message: unknown = JSON.parse(data);
    if (typeof message === "object" && message && "type" in message && message.type === "ping")
      socket.send(JSON.stringify({ type: "pong" }));
    else void Promise.resolve(open.send(message)).catch(() => socket.close(1011));
    return true;
  }
  const hello = ClientMessage.safeParse(JSON.parse(data));
  if (!hello.success || hello.data.type !== "hello") return false;
  const channel = hello.data.channel;
  if (channel !== "devices" && channel !== "screen") return false;
  main.delete(socket);
  socket.send(
    JSON.stringify({
      type: "welcome",
      hostId: daemon.hostId,
      protocolVersion: 1,
      headSeq: daemon.head,
    }),
  );
  const events = {
    ready: () => {},
    message: (message: unknown) => {
      if (message instanceof Uint8Array) socket.send(message);
      else socket.send(JSON.stringify(message));
    },
    close: () => socket.close(1000),
  };
  if (channel === "devices") {
    const transport = daemon.appDevices.transport();
    transport.open(events);
    features.set(socket, {
      send: (message) => transport.send(z.union([DeviceAck, DeviceClientMessage]).parse(message)),
      close: () => transport.close(),
    });
  } else {
    const transport = daemon.screen.transport();
    transport.open(events);
    features.set(socket, {
      send: (message) => transport.send(z.union([ScreenAck, ScreenClientMessage]).parse(message)),
      close: () => transport.close(),
    });
  }
  return true;
}

/** `GET /devices/inputs`: every input a person sent to a device, for tests that drive the screen. */
export function devicesControl(daemon: FakeDaemon, request: Request): Response | undefined {
  if (request.method !== "GET") return undefined;
  const path = new URL(request.url).pathname;
  if (path === "/devices/inputs") return Response.json({ inputs: daemon.appDevices.inputs });
  // How each foldable device sits, for the posture UI test.
  if (path === "/devices/folds")
    return Response.json({ folds: Object.fromEntries(daemon.appDevices.folds) });
  return undefined;
}

export function featureClosed(socket: Socket): void {
  features.get(socket)?.close();
  features.delete(socket);
}
