import { afterEach, expect, it } from "vitest";
import http2 from "node:http2";
import { createServer, type Server, type Socket } from "node:net";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
async function until<T>(read: () => T | undefined | Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition was not reached");
}

/** A control-only scrcpy server: dummy byte and device name on its one socket, which is control. */
async function fakeControl() {
  const sockets: Socket[] = [];
  let control = Buffer.alloc(0);
  const server: Server = createServer((socket) => {
    sockets.push(socket);
    socket.on("error", (error) => {
      // Capture teardown can reset this synthetic control connection before its writes drain.
      if (!("code" in error) || error.code !== "ECONNRESET") throw error;
    });
    const name = Buffer.alloc(64);
    name.write("sdk_gphone64_arm64");
    socket.write(Buffer.concat([Buffer.from([0]), name]));
    socket.on("data", (chunk: Buffer) => {
      control = Buffer.concat([control, chunk]);
    });
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
  return { port: address.port, control: () => control };
}

/** Field number → varint value, for the fake emulator reading ace's request. */
function varints(message: Buffer): Map<number, number | Buffer> {
  const out = new Map<number, number | Buffer>();
  let offset = 0;
  const read = () => {
    let value = 0;
    let scale = 1;
    for (;;) {
      const byte = message[offset++] ?? 0;
      value += (byte & 0x7f) * scale;
      scale *= 128;
      if (byte < 0x80) return value;
    }
  };
  while (offset < message.length) {
    const tag = read();
    if ((tag & 7) === 0) out.set(tag >> 3, read());
    else {
      const length = read();
      out.set(tag >> 3, message.subarray(offset, offset + length));
      offset += length;
    }
  }
  return out;
}

/**
 * The emulator's gRPC screen stream, played by a local HTTP/2 server: it checks the token, reads
 * the box and shared file ace asks for, and announces pictures that fit the box (portrait 9:20).
 */
async function fakeEmulator(token: string) {
  const requests: { box: number; file: string; authorized: boolean }[] = [];
  const streams = new Set<http2.ServerHttp2Stream>();
  const server = http2.createServer();
  let seq = 0;
  server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
    const authorized = headers["authorization"] === `Bearer ${token}`;
    let body = Buffer.alloc(0);
    stream.on("data", (chunk: Buffer) => {
      body = Buffer.concat([body, chunk]);
    });
    stream.on("end", () => {
      const request = varints(body.subarray(5));
      const transport = request.get(6);
      const handle = transport instanceof Buffer ? varints(transport).get(2) : undefined;
      const box = Number(request.get(4));
      requests.push({
        box,
        file: handle instanceof Buffer ? handle.toString().replace("file://", "") : "",
        authorized,
      });
      if (!authorized) {
        stream.respond(
          { ":status": 200, "content-type": "application/grpc", "grpc-status": "16" },
          { endStream: true },
        );
        return;
      }
      stream.respond({ ":status": 200, "content-type": "application/grpc" });
      streams.add(stream);
      stream.on("close", () => streams.delete(stream));
      const height = Math.min(box, 2400);
      const width = Math.round((height * 9) / 20);
      const notice = () => {
        const format = Buffer.from([0x18, ...varint(width), 0x20, ...varint(height)]);
        const image = Buffer.from([0x0a, format.length, ...format, 0x28, ...varint(++seq)]);
        const frame = Buffer.alloc(5 + image.length);
        frame.writeUInt32BE(image.length, 1);
        image.copy(frame, 5);
        if (!stream.closed) stream.write(frame);
      };
      const timer = setInterval(notice, 20);
      stream.on("close", () => clearInterval(timer));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        for (const stream of streams) stream.close();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  return { port: address.port, requests };
}
function varint(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return bytes;
}

/**
 * The screen helper's `--encode-frames` mode, played by a script: each frame command becomes a
 * packet (a keyframe first and when asked), and every command is logged for the test.
 */
const fakeEncoder = (log: string) => `
const fs = require("fs");
const readline = require("readline");
let key = true;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  fs.appendFileSync(${JSON.stringify(log)}, line + "\\n");
  const command = JSON.parse(line);
  if (command.op === "keyframe") key = true;
  if (command.op !== "frame") return;
  const payload = Buffer.from(key ? [0, 0, 0, 1, 0x67, 0x64, 0, 0x33, 0, 0, 0, 1, 0x65, 1] : [0, 0, 0, 1, 0x41, 2]);
  const header = Buffer.from(JSON.stringify({
    version: 2, sessionId: "emulator", seq: command.seq, ts: command.ts,
    width: command.width, height: command.height, scale: 1, codec: "h264",
    keyframe: key, ...(key ? { videoCodec: "avc1.640033" } : {}), bytes: payload.length,
  }));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  process.stdout.write(Buffer.concat([length, header, payload]));
  key = false;
});
`;

async function fixture(token = "secret") {
  const root = await mkdtemp(join(tmpdir(), "ace-host-capture-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "sdk/platform-tools"), { recursive: true });
  await mkdir(join(root, "sdk/emulator"), { recursive: true });
  await mkdir(join(root, "bin"), { recursive: true });
  await nodeBinary(join(root, "sdk/platform-tools"), "adb", "process.stdin.resume();");
  await nodeBinary(join(root, "sdk/emulator"), "emulator", "");
  const log = join(root, "encoder.log");
  const encoder = await nodeBinary(join(root, "bin"), "encoder", fakeEncoder(log));
  const jar = join(root, "scrcpy-server");
  await writeFile(jar, "server");
  const device = await fakeControl();
  const emulator = await fakeEmulator("secret");
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
  const started: string[] = [];
  const capture: DeviceCapture = await scrcpyCapture({
    device: android,
    streamId: "stream",
    fps: 60,
    jar,
    platform,
    env,
    runtime: {
      now: () => 1000,
      id: () => `id-${started.length}`,
      after(ms, run) {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      },
      spawn: (options) => {
        started.push([options.command, ...(options.args ?? [])].join(" "));
        return spawnRawSupervised(options);
      },
    },
    publish: (frame) => frames.push(frame),
    failure: (error) => failures.push(error),
    host: { grpc: { port: emulator.port, token }, encoder, directory: root },
  });
  cleanup.push(() => capture.stop());
  const encoded = async () =>
    (await readFile(log, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { op: string; bitrate?: number });
  return { capture, device, emulator, frames, failures, started, encoded, root };
}

it("an emulator encoded on the host streams the helper's H.264, and scrcpy runs control only", async () => {
  const { frames, started, emulator } = await fixture();
  const key = await until(() => frames.find((frame) => frame.header.keyframe));
  // The picture fits the box ace asked the emulator for; its scale is against the display.
  const box = emulator.requests[0]?.box ?? 0;
  const height = Math.min(box, 2400);
  const width = Math.round((height * 9) / 20);
  expect(key.header).toMatchObject({
    codec: "h264",
    keyframe: true,
    videoCodec: "avc1.640033",
    width,
    height,
    scale: width / 1080,
  });
  await until(() => (frames.some((frame) => !frame.header.keyframe) ? true : undefined));
  // One server run, with no video of its own.
  const servers = started.filter((line) => line.includes("app_process"));
  expect(servers).toHaveLength(1);
  expect(servers[0]).toContain("video=false");
  expect(servers[0]).not.toContain("video_codec");
  expect(emulator.requests[0]).toMatchObject({ authorized: true });
});

it("a tap reaches the control socket in the host picture's pixels", async () => {
  const { capture, device, frames, emulator } = await fixture();
  await until(() => (frames.length ? true : undefined));
  // A smaller picture: the view asked for a phone-sized box.
  await capture.configure?.({
    codec: "h264",
    maxWidth: 360,
    maxHeight: 800,
    fps: 60,
    bitrate: 4_000_000,
  });
  await until(() => (emulator.requests.some((request) => request.box === 800) ? true : undefined));
  await until(() => (frames.some((frame) => frame.header.height === 800) ? true : undefined));
  await capture.input?.({ kind: "pointer", phase: "down", x: 540, y: 1200 }, () => {});
  const bytes = await until(() => (device.control().length >= 32 ? device.control() : undefined));
  expect({
    x: bytes.readInt32BE(10),
    y: bytes.readInt32BE(14),
    width: bytes.readUInt16BE(18),
    height: bytes.readUInt16BE(20),
  }).toEqual({ x: 180, y: 400, width: 360, height: 800 });
});

it("a new size restarts only the screen stream and a new bit rate reaches the encoder in place", async () => {
  const { capture, emulator, started, encoded, frames } = await fixture();
  await until(() => (frames.length ? true : undefined));
  await capture.configure?.({
    codec: "h264",
    maxWidth: 720,
    maxHeight: 1600,
    fps: 60,
    bitrate: 3_000_000,
  });
  await until(() => (emulator.requests.some((request) => request.box === 1600) ? true : undefined));
  const commands = await until(async () => {
    const lines = await encoded();
    return lines.some((line) => line.op === "bitrate" && line.bitrate === 3_000_000)
      ? lines
      : undefined;
  });
  expect(commands.some((line) => line.op === "bitrate")).toBe(true);
  expect(started.filter((line) => line.includes("app_process"))).toHaveLength(1);
  await capture.keyframe?.();
  await until(async () =>
    (await encoded()).some((line) => line.op === "keyframe") ? true : undefined,
  );
});

it("stopping removes the shared picture file", async () => {
  const { capture, emulator, frames } = await fixture();
  await until(() => (frames.length ? true : undefined));
  const file = emulator.requests[0]?.file ?? "";
  await expect(access(file)).resolves.toBeUndefined();
  await capture.stop();
  await expect(access(file)).rejects.toThrow();
});

it("an emulator that refuses the token leaves the picture to scrcpy", async () => {
  const { started } = await fixture("wrong");
  const servers = await until(() => {
    const lines = started.filter((line) => line.includes("app_process"));
    return lines.length ? lines : undefined;
  });
  expect(servers[0]).toContain("video=true");
});
