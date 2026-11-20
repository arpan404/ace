import { afterEach, expect, it } from "vitest";
import { fixture as scrcpyFixture, nal, sps, until, type Cleanup } from "./testing/fake-scrcpy.ts";

const cleanup: Cleanup = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
const fixture = (options: { ffmpeg?: boolean; resetAtControl?: boolean } = {}) =>
  scrcpyFixture(cleanup, options);
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
  const reading = capture.clipboard?.read(() => {}, "agent");
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
  expect(await capture.clipboard?.read(() => {}, "agent")).toBe("");
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

it("a device stopped while it switches to still images leaves no ffmpeg running", async () => {
  const { capture, ffmpegPids } = await fixture({ ffmpeg: true });
  const switching = capture.configure?.({
    codec: "jpeg",
    maxWidth: 1920,
    maxHeight: 2160,
    fps: 60,
    bitrate: 4_000_000,
  });
  await capture.stop();
  await switching?.catch(() => {});
  // Give a late decoder time to start, then check none outlived the device.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const running = (await ffmpegPids()).filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  expect(running).toEqual([]);
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

it("an emulator that resets its sockets during startup fails the view, not the daemon", async () => {
  await expect(fixture({ resetAtControl: true })).rejects.toMatchObject({
    code: "command_failed",
  });
});
