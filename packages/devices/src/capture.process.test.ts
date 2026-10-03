import { afterEach, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScreenManager, type Frame } from "@ace/screen";
import { ScreenFrameReader } from "@ace/screen/frames-client";
import { spawnRawSupervised, type RawSupervisedProcess } from "@ace/provider-kit/process";
import { DevicePlatform, startCapture } from "./index.ts";
import type { DeviceRuntime } from "./runtime.ts";

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
async function fixture(mode = "stream") {
  const root = await mkdtemp(join(tmpdir(), "ace-device-capture-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const scripts = {
    "platform-tools/adb": `import { createInterface } from "node:readline";
createInterface({input:process.stdin}).on("line",line=>{
  if(line==="end") process.exit(0);
  else process.stdout.write(Buffer.from([Number(line)]));
});`,
    "emulator/emulator": "process.stdin.resume();",
    ffmpeg: `const width=Number(process.env.WIDTH),height=Number(process.env.HEIGHT);
const image=Buffer.from([255,216,255,192,0,8,8,height>>8,height&255,width>>8,width&255,1,255,217]);
if(process.env.MODE==="early") process.exit(7);
process.stdin.on("data",chunk=>{
  for(const byte of chunk){
    if(byte===1) process.stdout.write(image.subarray(0,image.length-1),()=>process.stderr.write("prefix\\n"));
    if(byte===2) process.stdout.write(image.subarray(image.length-1));
    if(byte===3) process.stdout.write(image);
  }
});
process.stdin.on("end",()=>process.exit(0));`,
  };
  for (const [relative, script] of Object.entries(scripts)) {
    const path = join(root, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, `#!${process.execPath}\n${script}\n`);
    await chmod(path, 0o700);
  }
  let guest = "640x1280";
  const env = { PATH: root, ANDROID_HOME: root, MODE: mode, WIDTH: "320", HEIGHT: "640" };
  const platform = new DevicePlatform({
    platform: "linux",
    home: root,
    env,
    async probe(_command, args) {
      const command = args.join(" ");
      const stdout =
        command === "-list-avds"
          ? "Pixel"
          : command === "devices -l"
            ? "List of devices attached\nemulator-5554 device"
            : command.endsWith("emu avd name")
              ? "Pixel\nOK"
              : `Physical size: ${guest}`;
      return { stdout, stderr: "", code: 0 };
    },
  });
  const processes: RawSupervisedProcess[] = [];
  const inputs: RawSupervisedProcess[] = [];
  const outputs: RawSupervisedProcess[] = [];
  const prefix = deferred<void>();
  const timer = deferred<void>();
  const timers = new Set<() => void>();
  const runtime: DeviceRuntime = {
    now: () => 1234,
    id: () => "capture",
    after(_ms, run) {
      const fire = () => {
        timers.delete(fire);
        run();
      };
      timers.add(fire);
      timer.resolve();
      return () => {
        timers.delete(fire);
      };
    },
    spawn(options) {
      const child = spawnRawSupervised(options);
      processes.push(child);
      if (options.name === "device-h264") inputs.push(child);
      else {
        outputs.push(child);
        child.stderr.on("data", () => prefix.resolve());
      }
      return child;
    },
  };
  const frames: Frame[] = [];
  const waiters: ((frame: Frame) => void)[] = [];
  const failures: unknown[] = [];
  const failed = deferred<unknown>();
  const capture = await startCapture({
    device: {
      id: "android:Pixel",
      name: "Pixel",
      platform: "android",
      state: "booted",
      serial: "emulator-5554",
    },
    streamId: "shared-capture",
    fps: 10,
    platform,
    runtime,
    env,
    publish(frame) {
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else frames.push(frame);
    },
    failure(error) {
      failures.push(error);
      failed.resolve(error);
    },
  });
  cleanup.push(() => capture.stop());
  cleanup.push(() => platform.close());
  function input() {
    const child = inputs.at(-1);
    if (!child) throw new Error("No capture process");
    return child;
  }
  return {
    capture,
    processes,
    inputs,
    outputs,
    failures,
    failed,
    prefix,
    timer,
    timers,
    frame(): Promise<Frame> {
      const frame = frames.shift();
      return frame ? Promise.resolve(frame) : new Promise((resolve) => waiters.push(resolve));
    },
    send(byte: number) {
      input().stdin.write(`${byte}\n`);
    },
    end() {
      input().stdin.write("end\n");
    },
    rotate() {
      guest = "800x400";
      env.WIDTH = "400";
      env.HEIGHT = "200";
    },
  };
}

it("fragmented Android JPEGs retain guest scale and the shared binary screen packet", async () => {
  const f = await fixture();
  f.send(1);
  await f.prefix.promise;
  f.send(2);
  const frame = await f.frame();
  expect(frame.header).toMatchObject({
    sessionId: "shared-capture",
    sequence: 0,
    timestamp: 1234,
    width: 320,
    height: 640,
    scale: 0.5,
  });
  expect(frame.payload).toEqual(
    Buffer.from([255, 216, 255, 192, 0, 8, 8, 2, 128, 1, 64, 1, 255, 217]),
  );
  const decoded: Uint8Array[] = [];
  const reader = new ScreenFrameReader((value) => decoded.push(value.payload));
  reader.push(frame.packet);
  reader.end();
  expect(Buffer.from(decoded[0] ?? [])).toEqual(frame.payload);
  expect(f.failures).toEqual([]);
});

it("an early Android decoder exit fails once and terminates the screenrecord process", async () => {
  const f = await fixture("early");
  await expect(f.failed.promise).resolves.toMatchObject({ code: "command_failed" });
  await Promise.all(f.processes.map((child) => child.exited));
  expect(f.failures).toHaveLength(1);
  expect(f.timers.size).toBe(0);
  await expect(f.capture.restart?.()).rejects.toMatchObject({ code: "busy" });
});

it("rotation replaces both capture processes while retaining stream identity and sequence", async () => {
  const f = await fixture();
  f.send(3);
  expect((await f.frame()).header).toMatchObject({ sequence: 0, width: 320, height: 640 });
  const previous = [...f.processes];
  f.rotate();
  const restart = f.capture.restart;
  if (!restart) throw new Error("Android capture does not support restart");
  await Promise.all([restart(), restart()]);
  expect(await Promise.all(previous.map((child) => child.exited))).toHaveLength(2);
  f.send(3);
  expect((await f.frame()).header).toMatchObject({
    sessionId: "shared-capture",
    sequence: 1,
    width: 400,
    height: 200,
    scale: 0.5,
  });
  expect(f.failures).toEqual([]);
  await f.capture.stop();
  expect(
    (await Promise.all(f.processes.map((child) => child.exited))).every(
      (exit) => exit.reason === "stopped",
    ),
  ).toBe(true);
});

it("closing during a restart cannot spawn another cycle or leave a natural restart pending", async () => {
  const f = await fixture();
  f.end();
  await f.timer.promise;
  const callback = [...f.timers][0];
  const restart = f.capture.restart;
  if (!restart) throw new Error("Android capture does not support restart");
  await Promise.all([restart(), f.capture.stop()]);
  callback?.();
  expect(f.timers.size).toBe(0);
  expect(f.inputs).toHaveLength(1);
  await Promise.all(f.processes.map((child) => child.exited));
  expect(f.failures).toEqual([]);
});

it("the finite native screenrecord boundary restarts capture without resetting frame sequence", async () => {
  const f = await fixture();
  f.send(3);
  expect((await f.frame()).header).toMatchObject({ sequence: 0 });
  f.end();
  await f.timer.promise;
  const restart = [...f.timers][0];
  if (!restart) throw new Error("Missing native-boundary restart");
  restart();
  f.send(3);
  expect((await f.frame()).header).toMatchObject({ sessionId: "shared-capture", sequence: 1 });
  await f.capture.stop();
  await Promise.all(f.processes.map((child) => child.exited));
  expect(f.failures).toEqual([]);
});

const simulatorTarget = {
  kind: "window",
  bundleId: "com.apple.iphonesimulator",
  windowId: 42,
} as const;
async function simulator() {
  const root = await mkdtemp(join(tmpdir(), "ace-simulator-capture-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const platform = new DevicePlatform({ platform: "linux", home: root, env: {} });
  cleanup.push(() => platform.close());
  let id = 0;
  const screen = new ScreenManager({
    command: process.execPath,
    args: [new URL("./testing/capture-helper.ts", import.meta.url).pathname],
    platform: "darwin",
    protocolVersion: 1,
    nextId: () => `native-simulator-${++id}`,
    recordingDirectory: root,
    async publishArtifact() {},
  });
  cleanup.push(() => screen.close());
  await screen.enable(true);
  await screen.approve(simulatorTarget.bundleId, true);
  const start = (publish: (frame: Frame) => void = noop) =>
    startCapture({
      device: {
        id: "ios:11111111-1111-1111-1111-111111111111",
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
  const observers = Array.from({ length: 64 }, () => f.screen.watch(noop));
  await expect(f.start()).rejects.toThrow("subscriber limit");
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
