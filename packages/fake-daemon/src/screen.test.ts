import { expect, it, onTestFinished } from "vitest";
import { Client } from "@ace/client";
import { ScreenClient } from "@ace/client/screen";
import { ScreenStreamClient, type PortableFrame } from "@ace/client/screen-stream";
import { DeviceClient } from "@ace/client/devices";
import { DeviceId, ScreenState, ThreadId, ThreadView } from "@ace/protocol";
import { FakeDaemon, fakeTransport } from "./index.ts";

function noop() {}
async function fixture(deviceId = "owner", scopes?: readonly ("read" | "operate" | "admin")[]) {
  let id = 0;
  const timers = new Map<() => void, number>();
  const daemon = new FakeDaemon({
    clock: () => 1000,
    screenId: () => `screen-${++id}`,
    screenSchedule: (callback, delay) => {
      timers.set(callback, delay);
      return () => {
        timers.delete(callback);
      };
    },
    ...(scopes ? { deviceScopes: { [deviceId]: scopes } } : {}),
  });
  daemon.createThread({
    id: "thread",
    workspaceId: "workspace",
    title: "Computer use",
    provider: "codex",
    access: "ask",
  });
  daemon.apply("thread", [{ type: "turn.started", agent: "root", trigger: "user" }]);
  const client = new Client({
    deviceId: DeviceId.parse(deviceId),
    transport: () => fakeTransport(daemon),
    credential: async () => daemon.token,
    storage: { load: async () => null, save: async () => {} },
    scheduler: { set: () => () => {} },
    random: () => 0,
    id: () => `request-${++id}`,
  });
  onTestFinished(() => client.close());
  const ready = new Promise<void>((resolve) => {
    const stop = client.connectionState().subscribe(() => {
      if (client.state === "ready") {
        stop();
        resolve();
      }
    });
  });
  await client.start();
  await ready;
  const stream = new ScreenStreamClient({
    id: () => `stream-request-${++id}`,
    schedule: () => () => {},
  });
  onTestFinished(() => stream.disconnect());
  stream.connect(daemon.screen.transport());
  await new Promise<void>((resolve) => {
    let stop = noop;
    stop = stream.watch((state) => {
      if (state.connected) {
        stop();
        resolve();
      }
    });
  });
  const screen = new ScreenClient(client);
  const view = () =>
    ThreadView.parse(daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("thread") }));
  const agentId = view().thread.rootAgentId;
  if (!agentId) throw new Error("Missing root agent");
  const holder = { threadId: ThreadId.parse("thread"), agentId };
  return { daemon, client, stream, screen, view, holder, timers };
}

it("fake screen enablement and permissions stay synchronized across main and dedicated connections", async () => {
  const f = await fixture();
  const enabled: boolean[] = [];
  const stop = f.screen.watchEnabled((value) => enabled.push(value));
  onTestFinished(stop);
  expect(await f.screen.status()).toEqual({
    enabled: false,
    sessions: 0,
    permissions: { screenRecording: false, accessibility: false },
  });
  await f.stream.request({ op: "enable", enabled: true });
  expect(enabled).toEqual([true]);
  expect(f.stream.getSnapshot().enabled).toBe(true);
  expect(await f.stream.request({ op: "targets" })).toMatchObject({
    windows: [
      { bundleId: "com.apple.TextEdit" },
      { bundleId: "com.apple.Safari" },
      { bundleId: "com.apple.calculator" },
      { bundleId: "com.apple.iphonesimulator" },
    ],
  });
  f.daemon.screen.permissions.accessibility = false;
  expect(await f.screen.requestPermission("accessibility")).toMatchObject({ accessibility: false });
  expect(f.daemon.screen.requested).toEqual(["accessibility"]);
  await f.screen.enable(false);
  expect(f.stream.getSnapshot().enabled).toBe(false);
  expect(enabled).toEqual([true, false]);
});

it("fake targets enforce eight sessions, holder identity, unprompted foreground, takeover and the global stop", async () => {
  const f = await fixture();
  await f.screen.enable(true);
  const states: ScreenState[] = [];
  for (let i = 0; i < 8; i++) {
    const bundleId = `test.app.${i}`;
    states.push(await f.screen.start({ kind: "app", bundleId }));
  }
  const first = states[0];
  if (!first) throw new Error("Missing target");
  await f.screen.delegate(first.sessionId, f.holder);
  expect(
    f.stream.getSnapshot().states.find((state) => state.sessionId === first.sessionId),
  ).toMatchObject({ controller: "agent", holder: f.holder, mode: "background" });
  await expect(f.screen.start(first.target)).rejects.toMatchObject({
    errorCode: "target_busy",
    holder: { sessionId: first.sessionId },
  });
  await expect(
    f.screen.delegate(first.sessionId, { ...f.holder, agentId: "second" }),
  ).rejects.toMatchObject({ errorCode: "target_busy" });
  await expect(f.screen.start({ kind: "app", bundleId: "ninth.app" })).rejects.toMatchObject({
    errorCode: "busy",
  });
  const interactions = Object.keys(f.view().interactions).length;
  expect(
    ScreenState.parse(
      await f.stream.request({ op: "mode", sessionId: first.sessionId, mode: "foreground" }),
    ).mode,
  ).toBe("foreground");
  expect(Object.keys(f.view().interactions)).toHaveLength(interactions);
  await f.screen.secureInput(first.sessionId, true);
  await f.screen.takeover(first.sessionId);
  expect((await f.screen.sessions())[0]).toMatchObject({
    controller: "human",
    secureInputAllowed: false,
    mode: "background",
  });
  expect((await f.screen.sessions())[0]?.holder).toBeUndefined();
  await f.screen.stopAll();
  expect(await f.screen.status()).toMatchObject({ enabled: false, sessions: 0 });
  expect(f.stream.getSnapshot().states).toEqual([]);
});

it("fake desktop viewers decode JPEG packets and receive fresh frames after reconnect without replaying input", async () => {
  const f = await fixture();
  await f.screen.enable(true);
  expect(await f.screen.openApp("com.apple.TextEdit")).toMatchObject({
    mode: "background",
    bundleId: "com.apple.TextEdit",
  });
  const state = await f.screen.start({ kind: "app", bundleId: "com.apple.TextEdit" });
  const frames: PortableFrame[] = [];
  const stop = f.stream.watchFrames(state.sessionId, (frame) => {
    frames.push(frame);
  });
  onTestFinished(stop);
  await f.stream.request({ op: "subscribe", sessionId: state.sessionId });
  await Promise.resolve();
  expect(frames[0]?.header).toMatchObject({ sessionId: state.sessionId, codec: "jpeg" });
  expect([...(frames[0]?.payload.subarray(0, 2) ?? [])]).toEqual([255, 216]);
  await f.stream.request({ op: "controller", sessionId: state.sessionId, controller: "human" });
  f.stream.disconnect();
  expect((await f.screen.sessions())[0]?.controller).toBe("none");
  f.stream.connect(f.daemon.screen.transport());
  await Promise.resolve();
  const prior = frames.length;
  expect(f.stream.getSnapshot().states).toEqual([]);
  await f.stream.request({ op: "subscribe", sessionId: state.sessionId });
  await Promise.resolve();
  expect(frames.length).toBe(prior + 1);
});

it("non-admin fake devices receive correlated screen refusals and no screen state pushes", async () => {
  const f = await fixture("phone", ["read", "operate"]);
  await expect(f.screen.status()).rejects.toMatchObject({ errorCode: "forbidden" });
  await expect(f.screen.requestPermission("screenRecording")).rejects.toMatchObject({
    errorCode: "forbidden",
  });
  const pushes: string[] = [];
  const stop = f.client.onMessage((message) => {
    if (message.type.startsWith("screen.")) pushes.push(message.type);
  });
  onTestFinished(stop);
  await f.stream.request({ op: "enable", enabled: true });
  expect(pushes).toEqual([]);
});

it("fake device holder ids appear on delegation and disappear on human takeover", async () => {
  const f = await fixture();
  let id = 0;
  const devices = new DeviceClient({ id: () => `device-${++id}`, schedule: () => () => {} });
  onTestFinished(() => devices.disconnect());
  devices.connect(f.daemon.appDevices.transport());
  await Promise.resolve();
  const deviceId = "ios:7d1b2c4e-5a6f-4e8d-9b0a-1c2d3e4f5a6b";
  await devices.request({ op: "enable", enabled: true });
  await devices.request({ op: "controller", deviceId, controller: "agent", ...f.holder });
  expect(devices.getSnapshot().states[0]?.holder).toEqual(f.holder);
  await devices.request({ op: "controller", deviceId, controller: "human" });
  expect(devices.getSnapshot().states[0]?.holder).toBeUndefined();
});
