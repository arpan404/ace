import { createServer, type Server, type Socket } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeBinary } from "@ace/provider-kit/testing";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import type { Frame } from "@ace/screen";
import { DevicePlatform } from "../index.ts";
import { scrcpyCapture } from "../scrcpy-capture.ts";
import type { DeviceCapture } from "../capture.ts";
import type { DeviceMedia } from "../media-paths.ts";
import { loopbackMedia } from "./loopback-media.ts";

/** Cleanups the test file runs after each test, newest first. */
export type Cleanup = (() => Promise<void> | void)[];

export const nal = (...bytes: number[]) => Buffer.from([0, 0, 0, 1, ...bytes]);
export const sps = Buffer.concat([nal(0x67, 0x42, 0xc0, 0x29, 0x8d), nal(0x68, 0xce)]);
export function media(flags: number, payload: Buffer) {
  const head = Buffer.alloc(12);
  head.writeUInt8(flags, 0);
  head.writeUInt32BE(payload.length, 8);
  return Buffer.concat([head, payload]);
}
export function session(width: number, height: number) {
  const head = Buffer.alloc(12);
  head.writeUInt8(0x80, 0);
  head.writeUInt32BE(width, 4);
  head.writeUInt32BE(height, 8);
  return head;
}
export async function until<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition was not reached");
}

/**
 * The emulator side, played by a real local TCP server standing in for the adb-forwarded socket:
 * dummy byte on the first connection, device name once control connects, then video.
 */
export async function fakeDevice(cleanup: Cleanup, options: { resetAtControl?: boolean } = {}) {
  const sockets: Socket[] = [];
  let control = Buffer.alloc(0);
  const server: Server = createServer((socket) => {
    sockets.push(socket);
    if (sockets.length === 1) socket.write(Buffer.from([0]));
    else if (options.resetAtControl) {
      // The emulator dies before it names itself: control is reset at once, and the first
      // socket, still awaited for the device name, ends a moment later.
      socket.resetAndDestroy();
      setTimeout(() => sockets[0]?.destroy(), 200);
    } else {
      socket.on("data", (chunk: Buffer) => {
        control = Buffer.concat([control, chunk]);
      });
      const name = Buffer.alloc(64);
      name.write("sdk_gphone64_arm64");
      sockets[0]?.write(
        Buffer.concat([
          name,
          Buffer.from("h264"),
          session(540, 1200),
          media(0x40, sps),
          media(0x20, nal(0x65, 1)),
          media(0x00, nal(0x41, 2)),
        ]),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  return {
    port: address.port,
    control: () => control,
    write: (bytes: Buffer) => sockets[1]?.write(bytes),
    /** More video on the first socket, as the device's encoder sends it. */
    video: (bytes: Buffer) => sockets[0]?.write(bytes),
    hangUp: () => {
      for (const socket of sockets) socket.destroy();
    },
  };
}

export async function fixture(
  cleanup: Cleanup,
  options: {
    /** The device resets both sockets once control connects, before naming itself. */
    resetAtControl?: boolean;
    media?: DeviceMedia;
    now?: () => number;
    /** Each published frame, as it is published. */
    onFrame?: (frame: Frame) => void;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "ace-scrcpy-capture-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "sdk/platform-tools"), { recursive: true });
  await mkdir(join(root, "sdk/emulator"), { recursive: true });
  // The long-running `adb shell app_process ...` stays up until ace stops it.
  await nodeBinary(join(root, "sdk/platform-tools"), "adb", "process.stdin.resume();");
  await nodeBinary(join(root, "sdk/emulator"), "emulator", "");
  // PATH holds only this folder, so no tool from the host is found.
  await mkdir(join(root, "bin"));
  const jar = join(root, "scrcpy-server");
  await writeFile(jar, "server");
  const device = await fakeDevice(cleanup, { resetAtControl: options.resetAtControl ?? false });
  const commands: string[] = [];
  const env = {
    PATH: join(root, "bin"),
    ANDROID_HOME: join(root, "sdk"),
  };
  const platform = new DevicePlatform({
    platform: "linux",
    home: root,
    env,
    async probe(_command, args) {
      const line = args.join(" ");
      commands.push(line);
      const stdout = line.includes("-list-avds")
        ? "Pixel"
        : line === "devices -l"
          ? "List of devices attached\nemulator-5554 device"
          : line.includes("avd_name")
            ? "Pixel"
            : line.includes("'wm' 'size'")
              ? "Physical size: 1080x2400"
              : line.includes("'dumpsys' 'input'")
                ? "SurfaceOrientation: 0"
                : line.includes("forward tcp:0")
                  ? `${device.port}\n`
                  : "";
      return { stdout, stderr: "", code: 0 };
    },
  });
  cleanup.push(() => platform.close());
  const android = (await platform.list()).find((entry) => entry.platform === "android");
  if (!android) throw new Error("No emulator");
  const frames: Frame[] = [];
  const failures: unknown[] = [];
  const capture: DeviceCapture = await scrcpyCapture({
    device: android,
    streamId: "stream",
    fps: 60,
    jar,
    platform,
    env,
    runtime: {
      now: options.now ?? (() => 1000),
      id: () => "session",
      after(ms, run) {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      },
      spawn: spawnRawSupervised,
    },
    publish: (frame) => {
      frames.push(frame);
      options.onFrame?.(frame);
    },
    failure: (error) => failures.push(error),
    // Video comes only through ace-media: a loopback stands in for it unless a test brings one.
    media: options.media ?? (await loopbackMedia(cleanup)),
  });
  cleanup.push(() => capture.stop());
  return { capture, device, frames, failures, commands };
}
