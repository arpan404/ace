import { afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesService } from "@ace/files";
import { basename } from "node:path";
import { DeviceOperation } from "@ace/protocol/devices";
import { framePacket, type Frame, type RecordingArtifact } from "@ace/screen";
import {
  spawnRawSupervised,
  spawnSupervised,
  type SupervisedProcess,
  type RawSupervisedProcess,
} from "@ace/provider-kit/process";
import { DevicesService, DevicePlatform, agentOwner, type Actor } from "./index.ts";
import type { startCapture } from "./capture.ts";

/** Shared fixture for the devices service process tests: a scripted platform and service. */

export const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
function noop() {}
export function deferred<T>() {
  let resolve: (value: T) => void = noop;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export const human: Actor = { kind: "human", owner: "phone-1" };
export const agent: Actor = {
  kind: "agent",
  threadId: "thread-1",
  agentId: "agent-1",
  owner: agentOwner("thread-1", "agent-1"),
};
export const deviceId = "android:Pixel";
export function frame(streamId: string, sequence: number): Frame {
  const payload = Buffer.from(`jpeg-${sequence}`);
  const header = {
    version: 1 as const,
    sessionId: streamId,
    sequence,
    timestamp: sequence,
    width: 100,
    height: 200,
    codec: "jpeg" as const,
    bytes: payload.length,
  };
  return { header, payload, packet: framePacket(header, payload) };
}
export async function harness(
  withRegistry = false,
  cancelCapture = false,
  recordingDirectory?: string,
) {
  const root = await mkdtemp(join(tmpdir(), "ace-devices-service-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  for (const path of ["platform-tools/adb", "emulator/emulator"]) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), "#!/bin/sh\nexit 0\n");
    await chmod(join(root, path), 0o700);
  }
  let now = 0;
  let exists = true;
  let firstFrame = true;
  const frameDeadline = deferred<void>();
  let id = 0;
  const timers = new Map<() => void, number>();
  const files = withRegistry
    ? await FilesService.create({
        workspace: root,
        dataDir: join(root, "registry"),
        artifactRoots: [root],
        now: () => now,
        id: () => `artifact-${++id}`,
        authorize: () => true,
      })
    : undefined;
  if (files) cleanups.push(async () => files.close());
  const effects: string[] = [];
  const profiles: import("@ace/protocol").ScreenStreamSettings[] = [];
  const publications: RecordingArtifact[] = [];
  const published = deferred<void>();
  const publishing = deferred<void>();
  let publicationGate: ReturnType<typeof deferred<void>> | undefined;
  let native: RawSupervisedProcess | undefined;
  let logProcess: SupervisedProcess | undefined;
  let stopFailure = false;
  let stopGate: ReturnType<typeof deferred<void>> | undefined;
  const stopEntered = deferred<void>();
  let releaseGate: ReturnType<typeof deferred<void>> | undefined;
  const releaseEntered = deferred<void>();
  let captureOptions: Parameters<typeof startCapture>[0] | undefined;
  let inputGate: ReturnType<typeof deferred<void>> | undefined;
  let captureGate: ReturnType<typeof deferred<void>> | undefined;
  const captureEntered = deferred<void>();
  let inventoryEntered = deferred<void>();
  let inventoryGate: ReturnType<typeof deferred<void>> | undefined;
  const entered = deferred<void>();
  const platform = new DevicePlatform({
    platform: "linux",
    home: root,
    env: { ANDROID_HOME: root },
    spawn(options) {
      if (options.name !== "device-input") return spawnSupervised(options);
      const process = spawnSupervised({
        command: globalThis.process.execPath,
        args: [
          "-e",
          `
        let marker, ready=false;
        function finish(){if(marker && ready){console.log(marker+'0');marker=undefined;ready=false;}}
        require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
          if(line==='continue'){ready=true;finish();}
          else if(line.startsWith('printf')){marker=/ACE_INPUT_\\d+:/.exec(line)?.[0];finish();}
          else console.log('effect:'+line);
        });
      `,
        ],
        env: {},
        name: "fake-android-input",
      });
      process.stdout.on("line", (line: string) => {
        if (!line.startsWith("effect:")) return;
        effects.push(`-s emulator-5554 shell ${line.slice(7)}`);
        entered.resolve();
        void Promise.resolve(inputGate?.promise).then(() => process.stdin.write("continue\n"));
      });
      return process;
    },
    async probe(_command, args) {
      const command = args.join(" ");
      if (command === "-list-avds") return { stdout: exists ? "Pixel" : "", stderr: "", code: 0 };
      if (command === "devices -l") {
        if (inventoryGate) {
          inventoryEntered.resolve();
          await inventoryGate.promise;
        }
        return {
          stdout: exists
            ? "List of devices attached\nemulator-5554 device model:Pixel"
            : "List of devices attached\n",
          stderr: "",
          code: 0,
        };
      }
      if (command.endsWith("emu avd name")) return { stdout: "Pixel\nOK", stderr: "", code: 0 };
      if (command.includes("input") || args.includes("install")) {
        effects.push(command);
        entered.resolve();
        if (inputGate) await inputGate.promise;
      }
      return { stdout: "", stderr: "", code: 0 };
    },
  });
  const service = new DevicesService({
    platform,
    env: {},
    spawnLogs() {
      logProcess = spawnSupervised({
        command: process.execPath,
        args: ["-e", "process.stdin.pipe(process.stdout)"],
        env: {},
        name: "fake-device-log",
      });
      return logProcess;
    },
    recordingLimitBytes: 512,
    recordingDirectory: recordingDirectory ?? root,
    runtime: {
      now: () => now,
      id: () => `device-stream-${++id}`,
      spawn: spawnRawSupervised,
      after(ms, run) {
        if (ms === 100) {
          const timer = setTimeout(run, ms);
          return () => clearTimeout(timer);
        }
        if (ms === 10000) frameDeadline.resolve();
        timers.set(run, now + ms);
        return () => {
          timers.delete(run);
        };
      },
    },
    async capture(options) {
      captureOptions = options;
      native = spawnRawSupervised({
        command: process.execPath,
        args: ["-e", "process.stdin.resume()"],
        env: {},
        name: "fake-native-capture",
      });
      const owned = native;
      captureEntered.resolve();
      if (captureGate) {
        if (cancelCapture) {
          const cancelled = Promise.withResolvers<void>();
          const abort = () => cancelled.resolve();
          options.signal?.addEventListener("abort", abort, { once: true });
          try {
            await Promise.race([captureGate.promise, cancelled.promise]);
          } finally {
            options.signal?.removeEventListener("abort", abort);
          }
        } else await captureGate.promise;
      }
      if (cancelCapture && options.signal?.aborted) {
        await owned.stop({ graceMs: 0 });
        throw new DOMException("Capture startup cancelled", "AbortError");
      }
      if (firstFrame) options.publish(frame(options.streamId, 0));
      return {
        async releaseInput() {
          releaseEntered.resolve();
          await releaseGate?.promise;
        },
        async configure(settings) {
          profiles.push(settings);
          return { codec: settings.codec };
        },
        async stop() {
          stopEntered.resolve();
          if (stopGate) await stopGate.promise;
          await owned.stop({ graceMs: 0 });
          if (stopFailure) throw new Error("native cleanup failed");
        },
      };
    },
    async publishArtifact(artifact) {
      publications.push(artifact);
      publishing.resolve();
      if (publicationGate) await publicationGate.promise;
      published.resolve();
      if (files) {
        const registered = await files.registerArtifact({
          root,
          path: basename(artifact.path),
          name: "device.screen",
          category: "recording",
        });
        return { id: registered, bytes: artifact.bytes, mimeType: artifact.mimeType };
      }
      return { ...artifact };
    },
  });
  cleanups.push(() => service.close());
  const request = (raw: unknown, actor = human) =>
    service.request(DeviceOperation.parse(raw), actor);
  return {
    service,
    platform,
    frameDeadline,
    skipFirstFrame() {
      firstFrame = false;
    },
    removeDevice() {
      exists = false;
    },
    profiles,
    releaseEntered,
    blockRelease() {
      releaseGate = deferred<void>();
      return releaseGate;
    },
    request,
    effects,
    publications,
    published,
    publishing,
    blockPublication() {
      publicationGate = deferred<void>();
      return publicationGate;
    },
    files,
    entered,
    captureEntered,
    get inventoryEntered() {
      return inventoryEntered;
    },
    blockInventory() {
      inventoryEntered = deferred<void>();
      inventoryGate = deferred<void>();
      return inventoryGate;
    },
    deadlines(budget?: number) {
      for (const [run, at] of timers) if (budget === undefined || at - now === budget) run();
    },
    nativeStarted() {
      return native !== undefined;
    },
    stopEntered,
    nativeExit() {
      if (!native) throw new Error("No native capture");
      return native.exited;
    },
    logStarted() {
      return logProcess !== undefined;
    },
    logExit() {
      if (!logProcess) throw new Error("No log process");
      return logProcess.exited;
    },
    log(line: string) {
      if (!logProcess) throw new Error("No log process");
      logProcess.stdin.write(line + "\n");
    },
    failStop() {
      stopFailure = true;
    },
    clearStopFailure() {
      stopFailure = false;
    },
    blockStop() {
      stopGate = deferred<void>();
      return stopGate;
    },
    blockCapture() {
      captureGate = deferred<void>();
      return captureGate;
    },
    blockInput() {
      inputGate = deferred<void>();
      return inputGate;
    },
    time(at: number) {
      now = at;
    },
    publish(sequence: number, bytes?: number) {
      if (!captureOptions) throw new Error("Capture is not started");
      const image = frame(captureOptions.streamId, sequence);
      if (bytes !== undefined) {
        image.payload = Buffer.alloc(bytes, 7);
        image.header = { ...image.header, bytes };
        image.packet = framePacket(image.header, image.payload);
      }
      captureOptions.publish(image);
    },
    fail() {
      captureOptions?.failure(new Error("capture disconnected"));
    },
  };
}
/** A person hands the device to a thread's agent, which also moves the device to that thread. */
export function delegateTo(
  h: Awaited<ReturnType<typeof harness>>,
  threadId: string,
  agentId = "agent-1",
) {
  return h.request({ op: "controller", deviceId, controller: "agent", threadId, agentId });
}
export async function delegate(h: Awaited<ReturnType<typeof harness>>) {
  await h.request({ op: "enable", enabled: true });
  await delegateTo(h, "thread-1");
}
/** Devices on, and the device used by thread-1 with nobody in control. */
export async function bind(h: Awaited<ReturnType<typeof harness>>) {
  await delegate(h);
  await h.request({ op: "controller", deviceId, controller: "none" });
}
