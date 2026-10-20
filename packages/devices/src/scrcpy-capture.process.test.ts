import { afterEach, expect, it } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeBinary } from "@ace/provider-kit/testing";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import type { Frame } from "@ace/screen";
import { DevicePlatform } from "./index.ts";
import { scrcpyCapture } from "./scrcpy-capture.ts";
import type { DeviceCapture } from "./capture.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
const nal = (...bytes: number[]) => Buffer.from([0, 0, 0, 1, ...bytes]);
const sps = Buffer.concat([nal(0x67, 0x42, 0xc0, 0x29, 0x8d), nal(0x68, 0xce)]);
function media(flags: number, payload: Buffer) {
  const head = Buffer.alloc(12);
  head.writeUInt8(flags, 0);
  head.writeUInt32BE(payload.length, 8);
  return Buffer.concat([head, payload]);
}
function session(width: number, height: number) {
  const head = Buffer.alloc(12);
  head.writeUInt8(0x80, 0);
  head.writeUInt32BE(width, 4);
  head.writeUInt32BE(height, 8);
  return head;
}
async function until<T>(read: () => T | undefined): Promise<T> {
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
async function fakeDevice() {
  const sockets: Socket[] = [];
  let control = Buffer.alloc(0);
  const server: Server = createServer((socket) => {
    sockets.push(socket);
    if (sockets.length === 1) socket.write(Buffer.from([0]));
    else {
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
    hangUp: () => {
      for (const socket of sockets) socket.destroy();
    },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ace-scrcpy-capture-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "sdk/platform-tools"), { recursive: true });
  await mkdir(join(root, "sdk/emulator"), { recursive: true });
  // The long-running `adb shell app_process ...` stays up until ace stops it.
  await nodeBinary(join(root, "sdk/platform-tools"), "adb", "process.stdin.resume();");
  await nodeBinary(join(root, "sdk/emulator"), "emulator", "");
  const jar = join(root, "scrcpy-server");
  await writeFile(jar, "server");
  const device = await fakeDevice();
  const commands: string[] = [];
  const env = { PATH: "/usr/bin:/bin", ANDROID_HOME: join(root, "sdk") };
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
      now: () => 1000,
      id: () => "session",
      after(ms, run) {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      },
      spawn: spawnRawSupervised,
    },
    publish: (frame) => frames.push(frame),
    failure: (error) => failures.push(error),
  });
  cleanup.push(() => capture.stop());
  return { capture, device, frames, failures, commands };
}

it("the live view is the emulator's own H.264, and every keyframe can start a decoder", async () => {
  const { frames, commands } = await fixture();
  await until(() => (frames.length >= 2 ? true : undefined));
  const [key, delta] = frames;
  expect(key?.header).toMatchObject({
    codec: "h264",
    keyframe: true,
    videoCodec: "avc1.42C029",
    width: 540,
    height: 1200,
    scale: 0.5,
  });
  expect(key?.payload).toEqual(Buffer.concat([sps, nal(0x65, 1)]));
  expect(delta?.header).toMatchObject({ codec: "h264", keyframe: false });
  expect(delta?.payload).toEqual(nal(0x41, 2));
  // Pushed and started through one tunnel; no screenrecord and no ffmpeg anywhere.
  expect(commands.some((line) => line.startsWith("-s emulator-5554 push"))).toBe(true);
  expect(commands.some((line) => line.includes("screenrecord"))).toBe(false);
});

it("two fingers reach the device with their own pointer ids in video pixels", async () => {
  const { capture, device, frames } = await fixture();
  await until(() => (frames.length ? true : undefined));
  await capture.input?.({ kind: "pointer", phase: "down", x: 540, y: 1000 }, () => {});
  await capture.input?.(
    { kind: "pointer", phase: "down", x: 540, y: 1400, pointerId: 1 },
    () => {},
  );
  const bytes = await until(() => (device.control().length >= 64 ? device.control() : undefined));
  const touch = (offset: number) => ({
    type: bytes.readUInt8(offset),
    action: bytes.readUInt8(offset + 1),
    pointer: bytes.readBigInt64BE(offset + 2),
    x: bytes.readInt32BE(offset + 10),
    y: bytes.readInt32BE(offset + 14),
    width: bytes.readUInt16BE(offset + 18),
    height: bytes.readUInt16BE(offset + 20),
  });
  expect([touch(0), touch(32)]).toEqual([
    { type: 2, action: 0, pointer: 0n, x: 270, y: 500, width: 540, height: 1200 },
    { type: 2, action: 0, pointer: 1n, x: 270, y: 700, width: 540, height: 1200 },
  ]);
});

it("losing control lifts every finger still on the screen", async () => {
  const { capture, device, frames } = await fixture();
  await until(() => (frames.length ? true : undefined));
  await capture.input?.({ kind: "pointer", phase: "down", x: 100, y: 100, pointerId: 2 }, () => {});
  await capture.releaseInput?.();
  const bytes = await until(() => (device.control().length >= 64 ? device.control() : undefined));
  expect([bytes.readUInt8(33), bytes.readBigInt64BE(34)]).toEqual([1, 2n]);
});

it("Unicode text is pasted and the action finishes only when the device acknowledges it", async () => {
  const { capture, device, frames } = await fixture();
  await until(() => (frames.length ? true : undefined));
  let finished = false;
  const typing = capture
    .input?.({ kind: "type", text: "héllo 👋" }, () => {})
    .then(() => {
      finished = true;
    });
  const text = Buffer.from("héllo 👋");
  const bytes = await until(() =>
    device.control().length >= 14 + text.length ? device.control() : undefined,
  );
  expect(bytes.readUInt8(0)).toBe(9);
  expect(bytes.readUInt8(9)).toBe(1);
  expect(bytes.subarray(14).toString("utf8")).toBe("héllo 👋");
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(finished).toBe(false);
  const ack = Buffer.alloc(9);
  ack.writeUInt8(1, 0);
  ack.writeBigUInt64BE(bytes.readBigUInt64BE(1), 1);
  device.write(ack);
  await typing;
  expect(finished).toBe(true);
});

it("the emulator clipboard is read from the device's reply and set without pasting", async () => {
  const { capture, device, frames } = await fixture();
  await until(() => (frames.length ? true : undefined));
  const reading = capture.clipboard?.read(() => {});
  // A read asks without pressing copy first, then takes the device's clipboard message.
  await until(() => (device.control().length >= 2 ? true : undefined));
  expect(device.control()).toEqual(Buffer.from([8, 0]));
  const text = Buffer.from("née 👋");
  const reply = Buffer.alloc(5);
  reply.writeUInt32BE(text.length, 1);
  device.write(Buffer.concat([reply, text]));
  expect(await reading).toBe("née 👋");

  let finished = false;
  const writing = capture.clipboard
    ?.write("copied", () => {})
    .then(() => {
      finished = true;
    });
  const bytes = await until(() =>
    device.control().length >= 2 + 14 + 6 ? device.control().subarray(2) : undefined,
  );
  expect(bytes.readUInt8(0)).toBe(9);
  expect(bytes.readUInt8(9)).toBe(0);
  expect(bytes.subarray(14).toString("utf8")).toBe("copied");
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(finished).toBe(false);
  const ack = Buffer.alloc(9);
  ack.writeUInt8(1, 0);
  ack.writeBigUInt64BE(bytes.readBigUInt64BE(1), 1);
  device.write(ack);
  await writing;
  expect(finished).toBe(true);
});

it("an empty emulator clipboard, which the device never answers, reads as empty", async () => {
  const { capture, frames } = await fixture();
  await until(() => (frames.length ? true : undefined));
  expect(await capture.clipboard?.read(() => {})).toBe("");
});

it("a viewer's keyframe request resets the device encoder once the stream is running", async () => {
  const { capture, device, frames } = await fixture();
  await until(() => (frames.length ? true : undefined));
  await capture.keyframe?.();
  expect(await until(() => (device.control().length ? device.control() : undefined))).toEqual(
    Buffer.from([17]),
  );
});

it("without ffmpeg, a request for still images keeps the H.264 view rather than going dark", async () => {
  const { capture } = await fixture();
  await expect(
    capture.configure?.({
      codec: "jpeg",
      maxWidth: 1920,
      maxHeight: 2160,
      fps: 60,
      bitrate: 4_000_000,
    }),
  ).resolves.toEqual({ codec: "h264" });
});

it("the view fails when the emulator side of the stream goes away", async () => {
  const { device, frames, failures } = await fixture();
  await until(() => (frames.length ? true : undefined));
  device.hangUp();
  expect(await until(() => failures[0])).toMatchObject({ code: "command_failed" });
});

it("input after the emulator went away says the view ended, not that control is reconnecting", async () => {
  const { capture, device, frames, failures } = await fixture();
  await until(() => (frames.length ? true : undefined));
  device.hangUp();
  await until(() => failures[0]);
  await expect(capture.input?.({ kind: "tap", x: 10, y: 10 }, () => {})).rejects.toMatchObject({
    code: "command_failed",
    message: "The Android screen stream ended",
  });
});
