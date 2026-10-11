import { chmod, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import sharp from "sharp";
import { expect, it } from "vitest";
import { DevicePlatform, startCapture, type DeviceRuntime } from "./index.ts";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import type { Frame } from "@ace/screen";

const udid = "11111111-1111-4111-8111-111111111111";
it("native Simulator frames and input follow UDID without a window or macOS screen permissions", async () => {
  const home = await mkdtemp(join(tmpdir(), "sim-native-"));
  let response: import("node:http").ServerResponse | undefined;
  const closed = Promise.withResolvers<void>();
  const listening = Promise.withResolvers<number>();
  const server = createServer((req, res) => {
    expect(req.url).toBe("/stream.mjpeg");
    response = res;
    res.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=frame" });
    res.flushHeaders();
    res.on("close", () => closed.resolve());
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    listening.resolve(address.port);
  });
  const port = await listening.promise;
  const command = join(home, "serve-sim");
  await writeFile(
    command,
    `#!${process.execPath}\nconsole.log(JSON.stringify({device:${JSON.stringify(udid)},port:${port},streamUrl:'http://127.0.0.1:${port}/stream.mjpeg',wsUrl:'ws://127.0.0.1:${port}/ws'}));if(process.argv.includes('type')){require('node:fs').writeFileSync(${JSON.stringify(join(home, "typing"))},'ready');setInterval(()=>{},1000);}process.stdin.resume();`,
  );
  await chmod(command, 0o700);
  for (const name of ["xcode-select", "xcrun", "open"]) {
    await writeFile(join(home, name), "#!/bin/sh\nexit 0\n");
    await chmod(join(home, name), 0o700);
  }
  const platform = new DevicePlatform({
    platform: "darwin",
    home,
    env: { PATH: home },
    async probe(_command, args) {
      return {
        stdout:
          args[0] === "-p"
            ? "/Applications/Xcode.app/Contents/Developer"
            : JSON.stringify({
                devices: {
                  iOS: [
                    { udid, name: "Duplicate name", state: "Booted", isAvailable: true },
                    {
                      udid: "22222222-2222-4222-8222-222222222222",
                      name: "Duplicate name",
                      state: "Booted",
                      isAvailable: true,
                    },
                  ],
                },
              }),
        stderr: "",
        code: 0,
      };
    },
  });
  const hid: Buffer[] = [];
  const ws = new WebSocketServer({ server });
  const control = Promise.withResolvers<void>();
  ws.on("connection", (socket) =>
    socket.on("message", (bytes) => {
      if (!Buffer.isBuffer(bytes)) throw new Error("Invalid native HID packet");
      hid.push(Buffer.from(bytes));
      if (hid.length === 2) control.resolve();
    }),
  );
  const runtime: DeviceRuntime = {
    now: () => 1000,
    id: () => "native",
    spawn: spawnRawSupervised,
    after(ms, run) {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
  };
  const frames: Frame[] = [];
  const first = Promise.withResolvers<void>();
  let capture: Awaited<ReturnType<typeof startCapture>> | undefined;
  const failures: unknown[] = [];
  let afterPublish: (() => void) | undefined;
  try {
    capture = await startCapture({
      device: { id: `ios:${udid}`, name: "Duplicate name", platform: "ios", state: "booted" },
      streamId: "native",
      fps: 30,
      platform,
      runtime,
      env: { PATH: home },
      publish(frame) {
        frames.push(frame);
        first.resolve();
        afterPublish?.();
      },
      failure(error) {
        failures.push(error);
      },
    });
    const image = await sharp({
      create: { width: 200, height: 400, channels: 3, background: "white" },
    })
      .jpeg()
      .toBuffer();
    if (!response) throw new Error("No stream");
    const headers = Buffer.from(
      `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${image.length}\r\n\r\n`,
    );
    response.write(headers.subarray(0, 10));
    response.write(headers.subarray(10));
    response.write(image.subarray(0, 5));
    response.write(image.subarray(5));
    await first.promise;
    expect(frames[0]?.header).toMatchObject({
      width: 200,
      height: 400,
      scale: 1,
      codec: "jpeg",
      sessionId: "native",
    });
    if (!capture.input) throw new Error("Missing native input");
    await capture.input({ kind: "tap", x: 100, y: 200 }, () => {});
    await control.promise;
    expect(hid.map((bytes) => [bytes[0], JSON.parse(bytes.subarray(1).toString())])).toEqual([
      [3, { type: "begin", x: 0.5, y: 0.5 }],
      [3, { type: "end", x: 0.5, y: 0.5 }],
    ]);
    await capture.keyframe?.();
    expect(frames).toHaveLength(2);
    expect(frames[1]?.payload).toEqual(image);
    await expect(
      capture.input({ kind: "tap", x: 100, y: 200 }, () => {
        throw new Error("lease expired");
      }),
    ).rejects.toThrow("lease expired");
    expect(hid).toHaveLength(2);
    await capture.input(
      { kind: "swipe", x: 20, y: 40, toX: 100, toY: 200, durationMs: 32 },
      () => {},
    );
    await expect.poll(() => hid.length).toBe(6);
    expect(JSON.parse((hid.at(-1) ?? Buffer.alloc(0)).subarray(1).toString())).toEqual({
      type: "end",
      x: 0.5,
      y: 0.5,
    });
    await capture.input({ kind: "pointer", phase: "down", x: 20, y: 40 }, () => {});
    await capture.releaseInput?.();
    await expect.poll(() => hid.length).toBe(8);
    expect(JSON.parse((hid.at(-1) ?? Buffer.alloc(0)).subarray(1).toString())).toEqual({
      type: "end",
      x: 0.1,
      y: 0.1,
    });
    const gesture = capture.input({ kind: "longPress", x: 20, y: 40, durationMs: 10000 }, () => {});
    const rejectedGesture = expect(gesture).rejects.toThrow();
    await expect.poll(() => hid.length).toBe(9);
    await capture.releaseInput?.();
    await rejectedGesture;
    await expect.poll(() => hid.length).toBe(10);
    const reconfigured = Promise.withResolvers<void>();
    const ownedCapture = capture;
    afterPublish = () => {
      afterPublish = undefined;
      queueMicrotask(() => {
        void ownedCapture
          .configure?.({ codec: "jpeg", maxWidth: 150, maxHeight: 300, fps: 15, bitrate: 1000000 })
          .then(() => reconfigured.resolve(), reconfigured.reject);
      });
    };
    await capture.keyframe?.();
    await reconfigured.promise;
    expect(frames.at(-1)?.header).toMatchObject({ width: 150, height: 300, scale: 0.75 });
    await capture.configure?.({
      codec: "jpeg",
      maxWidth: 100,
      maxHeight: 200,
      fps: 15,
      bitrate: 1000000,
    });
    expect(frames.at(-1)?.header).toMatchObject({ width: 100, height: 200, scale: 0.5 });
    const typing = capture.input({ kind: "type", text: "hello" }, () => {});
    const rejectedTyping = expect(typing).rejects.toThrow();
    await expect.poll(() => readFile(join(home, "typing"), "utf8").catch(() => "")).toBe("ready");
    await capture.stop();
    await rejectedTyping;
    await closed.promise;
    expect(capture.terminated).toBe(true);
    expect(failures).toEqual([]);
  } finally {
    await capture?.stop();
    await platform.close();
    server.closeAllConnections();
    ws.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});
