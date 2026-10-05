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
async function fixture(mode = "stream", initialSerial = "emulator-5554") {
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
    if(byte===3) {
      if(process.argv.includes("copy")) {
        const nal=(...data)=>Buffer.from([0,0,0,1,...data]);
        process.stdout.write(Buffer.concat([nal(9,240),nal(103,66,224,31),nal(104,1),nal(101,3),nal(9,240),nal(65,4),nal(9,240),nal(65,5)]));
      } else process.stdout.write(image);
    }
  }
});
process.stdin.on("end",()=>process.exit(process.env.MODE==="endfailure"?7:0));`,
  };
  for (const [relative, script] of Object.entries(scripts)) {
    const path = join(root, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, `#!${process.execPath}\n${script}\n`);
    await chmod(path, 0o700);
  }
  let guest = "640x1280";
  let serial = initialSerial;
  let oldName = "Pixel";
  const probes: string[][] = [];
  const env = { PATH: root, ANDROID_HOME: root, MODE: mode, WIDTH: "320", HEIGHT: "640" };
  const platform = new DevicePlatform({
    platform: "linux",
    home: root,
    env,
    async probe(_command, args) {
      probes.push([...args]);
      const command = args.join(" ");
      if (mode === "dimensionmove" && command.includes("'wm' 'size'")) {
        serial = "emulator-5556";
        oldName = "OtherAVD";
      }
      const stdout =
        command === "-list-avds"
          ? "Pixel"
          : command === "devices -l"
            ? `List of devices attached\n${serial} device`
            : command.endsWith("emu avd name")
              ? `${args[1] === serial ? "Pixel" : oldName}\nOK`
              : `Physical size: ${guest}`;
      return { stdout, stderr: "", code: 0 };
    },
  });
  cleanup.push(() => platform.close());
  const captureSerials: string[] = [];
  const processes: RawSupervisedProcess[] = [];
  const inputs: RawSupervisedProcess[] = [];
  const outputs: RawSupervisedProcess[] = [];
  const prefix = deferred<void>();
  const timer = deferred<void>();
  const spawned = new Map<number, ReturnType<typeof deferred<void>>>();
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
      if (options.name === "device-h264") {
        captureSerials.push(options.args?.[1] ?? "");
        inputs.push(child);
        spawned.get(inputs.length)?.resolve();
      } else {
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
  function input() {
    const child = inputs.at(-1);
    if (!child) throw new Error("No capture process");
    return child;
  }
  return {
    capture,
    captureSerials,
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
    platform,
    probes,
    moveTransport(next: string) {
      serial = next;
      oldName = "OtherAVD";
    },
    waitForCycle(number: number) {
      if (inputs.length >= number) return Promise.resolve();
      const ready = spawned.get(number) ?? deferred<void>();
      spawned.set(number, ready);
      return ready.promise;
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
  await f.waitForCycle(2);
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
async function simulator(duplicate = false) {
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

it("capture dimensions and pixels use the same newly resolved Android transport", async () => {
  const f = await fixture("stream", "emulator-5556");
  f.send(3);
  const frame = await f.frame();
  expect(frame.header.scale).toBe(0.5);
  expect(f.captureSerials).toEqual(["emulator-5556"]);
  expect(f.probes).toContainEqual(["-s", "emulator-5556", "shell", "'wm' 'size'"]);
});

it("a transport moving between native cycles fails without starting capture on another AVD", async () => {
  const f = await fixture();
  f.send(3);
  await f.frame();
  f.moveTransport("emulator-5556");
  f.end();
  await f.timer.promise;
  const restart = [...f.timers][0];
  if (!restart) throw new Error("Missing boundary restart");
  restart();
  await expect(f.failed.promise).resolves.toMatchObject({ code: "not_found" });
  await Promise.all(f.processes.map((child) => child.exited));
  expect(f.inputs).toHaveLength(1);
  expect(f.failures).toHaveLength(1);
});

it("an inventory identity replacement stops an ongoing stream before another frame can be forwarded", async () => {
  const f = await fixture();
  f.send(3);
  await f.frame();
  f.moveTransport("emulator-5556");
  await f.platform.list();
  await expect(f.failed.promise).resolves.toMatchObject({ code: "not_found" });
  await Promise.all(f.processes.map((child) => child.exited));
  expect(f.failures).toHaveLength(1);
  expect(f.inputs).toHaveLength(1);
});

it("a decoder failure after screenrecord finishes terminates capture without scheduling another cycle", async () => {
  const f = await fixture("endfailure");
  f.send(3);
  expect((await f.frame()).header.sequence).toBe(0);
  f.end();
  await expect(f.failed.promise).resolves.toMatchObject({ code: "command_failed" });
  await Promise.all(f.processes.map((child) => child.exited));
  expect(f.failures).toHaveLength(1);
  expect(f.timers.size).toBe(0);
  expect(f.inputs).toHaveLength(1);
});

it("an Android transport changing during dimension lookup cannot start a capture process", async () => {
  await expect(fixture("dimensionmove")).rejects.toMatchObject({ code: "not_found" });
});

it("video negotiation forwards hardware access units and restores JPEG for image viewers", async () => {
  const f = await fixture();
  const configure = f.capture.configure;
  if (!configure) throw new Error("Capture cannot negotiate video");
  const settings = {
    codec: "h264" as const,
    maxWidth: 320,
    maxHeight: 640,
    fps: 30,
    bitrate: 1000000,
  };
  await configure(settings);
  f.send(3);
  const key = await f.frame();
  expect(key.header).toMatchObject({
    codec: "h264",
    keyframe: true,
    videoCodec: "avc1.42e01f",
    width: 320,
    height: 640,
    scale: 0.5,
  });
  expect(key.payload).toEqual(
    Buffer.from([0, 0, 0, 1, 103, 66, 224, 31, 0, 0, 0, 1, 104, 1, 0, 0, 0, 1, 101, 3]),
  );
  const delta = await f.frame();
  expect(delta.header).toMatchObject({ codec: "h264", keyframe: false });
  expect(delta.payload).toEqual(Buffer.from([0, 0, 0, 1, 65, 4]));
  await configure({ ...settings, codec: "jpeg" });
  f.send(3);
  const image = await f.frame();
  expect(image.header).toMatchObject({ codec: "jpeg", width: 320, height: 640, scale: 0.5 });
  expect(image.header.sequence).toBeGreaterThan(key.header.sequence);
  expect(f.failures).toEqual([]);
});
