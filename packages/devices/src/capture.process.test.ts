import { afterEach, expect, it } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScreenManager, type Frame } from "@ace/screen";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import { DevicePlatform, startCapture } from "./index.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
function noop() {}
function deferred<T>() {
  let resolve: (value: T) => void = noop;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
const simulatorTarget = {
  kind: "window",
  bundleId: "com.apple.iphonesimulator",
  windowId: 42,
} as const;
async function simulator(duplicate = false, windowBundle = "com.apple.iphonesimulator") {
  const root = await mkdtemp(join(tmpdir(), "ace-simulator-capture-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  for (const name of ["xcode-select", "xcrun", "open"]) {
    const path = join(root, name);
    await writeFile(path, `#!${process.execPath}\n`);
    await chmod(path, 0o700);
  }
  const platform = new DevicePlatform({
    platform: "darwin",
    home: root,
    env: { PATH: root },
    async probe(_command, args) {
      return {
        code: 0,
        stderr: "",
        stdout:
          args[0] === "-p"
            ? "/Applications/Xcode.app/Contents/Developer"
            : JSON.stringify({
                devices: {
                  iOS: [
                    {
                      udid: "11111111-1111-4111-8111-111111111111",
                      name: "iPhone",
                      state: "Booted",
                      isAvailable: true,
                    },
                    ...(duplicate
                      ? [
                          {
                            udid: "22222222-2222-4222-8222-222222222222",
                            name: "iPhone",
                            state: "Booted",
                            isAvailable: true,
                          },
                        ]
                      : []),
                  ],
                },
              }),
      };
    },
  });
  cleanup.push(() => platform.close());
  let id = 0;
  const screen = new ScreenManager({
    command: process.execPath,
    args: [
      new URL("./testing/capture-helper.ts", import.meta.url).pathname,
      `--window-bundle=${windowBundle}`,
    ],
    platform: "darwin",
    protocolVersion: 1,
    nextId: () => `native-simulator-${++id}`,
    recordingDirectory: root,
    async publishArtifact() {},
  });
  cleanup.push(() => screen.close());
  await screen.enable(true);
  const start = (publish: (frame: Frame) => void = noop) =>
    startCapture({
      device: {
        id: "ios:11111111-1111-4111-8111-111111111111",
        name: "iPhone",
        platform: "ios",
        state: "booted",
      },
      streamId: "devices-provisional-id",
      fps: 10,
      platform,
      screen,
      runtime: { now: () => 0, id: () => "unused", spawn: spawnRawSupervised, after: () => noop },
      env: {},
      publish,
      failure: noop,
    });
  return { screen, start };
}

it("an exhausted iOS state observer limit releases native capture capacity after setup fails", async () => {
  const f = await simulator();
  const observed = new Set<number>();
  const observers = Array.from({ length: 64 }, (_, viewer) =>
    f.screen.watch(() => {
      observed.add(viewer);
    }),
  );
  await expect(f.start()).rejects.toThrow("subscriber limit");
  expect(observed.size).toBe(64);
  expect(f.screen.states()).toEqual([]);
  for (const release of observers) release();
  const next = await f.screen.start(simulatorTarget);
  expect(f.screen.state(next.sessionId).lifecycle).toBe("live");
  await f.screen.stop(next.sessionId);
  expect(f.screen.states()).toEqual([]);
});

it("an exhausted iOS frame subscriber limit releases native capture capacity after setup fails", async () => {
  const f = await simulator();
  let occupied = false;
  const subscribers: (() => void)[] = [];
  const releaseObserver = f.screen.watch((state) => {
    if (state.lifecycle !== "live" || occupied) return;
    occupied = true;
    for (let index = 0; index < 64; index++)
      subscribers.push(f.screen.subscribe(state.sessionId, async () => {}));
  });
  await expect(f.start()).rejects.toThrow("Subscriber limit");
  expect(f.screen.states()).toEqual([]);
  releaseObserver();
  for (const release of subscribers) release();
  const next = await f.screen.start(simulatorTarget);
  expect(f.screen.state(next.sessionId).lifecycle).toBe("live");
  await f.screen.stop(next.sessionId);
  expect(f.screen.states()).toEqual([]);
});

it("iOS device capture forwards the native session and original image packet without a copy", async () => {
  const f = await simulator();
  const received = deferred<Frame>();
  const capture = await f.start(received.resolve);
  cleanup.push(() => capture.stop());
  const nativeId = capture.screenSessionId;
  if (!nativeId) throw new Error("Missing Simulator native session");
  expect(capture.streamId).toBe(nativeId);
  expect(nativeId).not.toBe("devices-provisional-id");
  f.screen.controller(nativeId, "human");
  await f.screen.action(nativeId, "human", { kind: "type", text: "frame" });
  const frame = await received.promise;
  const native = f.screen.screenshot(nativeId);
  expect(frame).toBe(native);
  expect(frame.packet).toBe(native.packet);
  expect(frame.payload).toBe(native.payload);
  expect(frame.header.sessionId).toBe(nativeId);
  expect(frame.payload.toString()).toBe("simulator-native-image");
  await capture.stop();
  expect(f.screen.states()).toEqual([]);
});

it.each(["com.apple.iphonesimulator", "com.apple.dt.Devices"])(
  "without serve-sim, the %s window shows the device alone, its own body the only frame",
  async (bundleId) => {
    const f = await simulator(false, bundleId);
    const capture = await f.start();
    cleanup.push(() => capture.stop());
    const nativeId = capture.screenSessionId;
    if (!nativeId) throw new Error("Missing Simulator native session");
    // The helper crops the title bar and toolbar off and takes input below them.
    expect(f.screen.state(nativeId).target).toEqual({
      kind: "window",
      bundleId,
      windowId: 42,
      content: true,
    });
    // The window shows the Simulator's bezel, so viewers draw no frame of their own.
    expect(capture.framed).toBe(true);
    await capture.stop();
  },
);

it("identically named booted Simulators cannot capture or control the only visible other window", async () => {
  const f = await simulator(true);
  await expect(f.start()).rejects.toMatchObject({
    code: "busy",
    hint: expect.stringContaining("Rename"),
  });
  expect(f.screen.states()).toEqual([]);
  // A rejection must leave native capture capacity available.
  const direct = await f.screen.start(simulatorTarget);
  expect(f.screen.state(direct.sessionId).lifecycle).toBe("live");
  await f.screen.stop(direct.sessionId);
});
