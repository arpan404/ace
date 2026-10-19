import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { WebSocketServer } from "ws";
import { expect, it, onTestFinished } from "vitest";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import type { Frame } from "@ace/screen";
import { DevicePlatform, startCapture, type DeviceRuntime } from "./index.ts";

const udid = "11111111-1111-4111-8111-111111111111";
const base = `/helper/${udid}`;
const description = Buffer.from(
  "01640033ffe1001627640033ac13143c04c0149e6a9a81010103c20108f801000428ee3cb0",
  "hex",
);
const record = (tag: number, body: Buffer) => {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(body.length + 1);
  head[4] = tag;
  return Buffer.concat([head, body]);
};
const unit = (nal: number[]) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(nal.length);
  return Buffer.concat([length, Buffer.from(nal)]);
};
const ax = [
  {
    type: "Application",
    AXLabel: "Settings",
    enabled: true,
    frame: { x: 0, y: 0, width: 402, height: 874 },
    children: [
      {
        type: "Button",
        AXLabel: "General",
        enabled: true,
        frame: { x: 0, y: 300, width: 402, height: 50 },
        children: [],
      },
    ],
  },
];

/** A stand-in for serve-sim's helper: MJPEG, AVCC, /ax and the HID socket on one port. */
async function fakeServeSim(home: string, version: string) {
  const avcc: ServerResponse[] = [];
  let avccOpened = 0;
  let mjpegOpen = 0;
  const jpeg = await sharp({
    create: { width: 201, height: 437, channels: 3, background: "white" },
  })
    .jpeg()
    .toBuffer();
  const server = createServer((req, res) => {
    if (req.url === `${base}/stream.mjpeg`) {
      mjpegOpen++;
      res.on("close", () => mjpegOpen--);
      res.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=frame" });
      res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
      res.write(jpeg);
      return;
    }
    if (req.url === `${base}/stream.avcc`) {
      avccOpened++;
      res.writeHead(200, { "content-type": "application/octet-stream" });
      avcc.push(res);
      res.on("close", () => avcc.splice(avcc.indexOf(res), 1));
      // Like serve-sim: a preview seed, then the description and an IDR for every subscriber.
      res.write(record(4, jpeg));
      res.write(Buffer.concat([record(1, description), record(2, unit([0x25, 0x88, avccOpened]))]));
      return;
    }
    if (req.url === `${base}/ax`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(ax));
      return;
    }
    res.writeHead(404).end();
  });
  const hid: unknown[] = [];
  const ws = new WebSocketServer({ server });
  ws.on("connection", (socket) => {
    socket.send(
      Buffer.concat([
        Buffer.from([130]),
        Buffer.from(JSON.stringify({ width: 1206, height: 2622, orientation: "portrait" })),
      ]),
    );
    socket.on("message", (bytes: Buffer) =>
      hid.push([bytes[0], JSON.parse(bytes.subarray(1).toString())]),
    );
  });
  const port = await new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    }),
  );
  const command = join(home, "serve-sim");
  await writeFile(
    command,
    `#!${process.execPath}\nif(process.argv.includes('--version')){console.log(${JSON.stringify(version)});process.exit(0);}console.log(JSON.stringify({device:${JSON.stringify(udid)},port:${port},streamUrl:'http://127.0.0.1:${port}${base}/stream.mjpeg',wsUrl:'ws://127.0.0.1:${port}${base}/ws'}));process.stdin.resume();`,
  );
  await chmod(command, 0o700);
  for (const name of ["xcode-select", "xcrun", "open"]) {
    await writeFile(join(home, name), "#!/bin/sh\nexit 0\n");
    await chmod(join(home, name), 0o700);
  }
  onTestFinished(async () => {
    server.closeAllConnections();
    ws.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    hid,
    avcc,
    opened: () => avccOpened,
    mjpegOpen: () => mjpegOpen,
    delta: (byte: number) => avcc.at(-1)?.write(record(3, unit([0x21, byte]))),
  };
}

function platformFor(home: string) {
  return new DevicePlatform({
    platform: "darwin",
    home,
    env: { PATH: home },
    async probe(_command, args) {
      return {
        stdout:
          args[0] === "-p"
            ? "/Applications/Xcode.app/Contents/Developer"
            : JSON.stringify({
                devices: { iOS: [{ udid, name: "iPhone", state: "Booted", isAvailable: true }] },
              }),
        stderr: "",
        code: 0,
      };
    },
  });
}
const runtime: DeviceRuntime = {
  now: () => 1000,
  id: () => "native",
  spawn: spawnRawSupervised,
  after(ms, run) {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};
const device = {
  id: `ios:${udid}`,
  name: "iPhone",
  platform: "ios" as const,
  state: "booted" as const,
};
const video = {
  codec: "h264" as const,
  maxWidth: 800,
  maxHeight: 1600,
  fps: 60,
  bitrate: 12000000,
};

it("viewers that decode H.264 get serve-sim's stream untouched, switching back to JPEG on request", async () => {
  const home = await mkdtemp(join(tmpdir(), "sim-h264-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const sim = await fakeServeSim(home, "0.1.48");
  const platform = platformFor(home);
  onTestFinished(() => platform.close());
  const frames: Frame[] = [];
  const failures: unknown[] = [];
  const capture = await startCapture({
    device,
    streamId: "native",
    fps: 30,
    platform,
    runtime,
    env: { PATH: home },
    publish: (frame) => frames.push(frame),
    failure: (error) => failures.push(error),
  });
  onTestFinished(() => capture.stop());
  await expect.poll(() => frames.length).toBeGreaterThan(0);
  expect(frames[0]?.header.codec).toBe("jpeg");

  expect(await capture.configure?.(video)).toEqual({ codec: "h264" });
  const key = frames.find((frame) => frame.header.codec === "h264");
  // Native size whatever the viewer's budget: nothing is scaled or re-encoded.
  expect(key?.header).toMatchObject({
    codec: "h264",
    keyframe: true,
    videoCodec: "avc1.640033",
    width: 1206,
    height: 2622,
    scale: 1,
  });
  expect(key?.payload.toString("hex")).toBe(
    "0000000127640033ac13143c04c0149e6a9a81010103c20108f8" + "0000000128ee3cb0" + "00000001258801",
  );
  await expect.poll(sim.mjpegOpen).toBe(0);

  sim.delta(0x55);
  await expect.poll(() => frames.at(-1)?.payload.toString("hex")).toBe("00000001" + "2155");
  expect(frames.at(-1)?.header).toMatchObject({ codec: "h264", keyframe: false });

  // A keyframe request opens a fresh subscription and leaves only that one open.
  await capture.keyframe?.();
  expect(sim.opened()).toBe(2);
  expect(frames.at(-1)?.payload.subarray(-3).toString("hex")).toBe("258802");
  await expect.poll(() => sim.avcc.length).toBe(1);
  const sequences = frames.map((frame) =>
    frame.header.version === 1 ? frame.header.sequence : -1,
  );
  expect(sequences).toEqual(sequences.map((_, index) => index));

  expect(await capture.configure?.({ ...video, codec: "jpeg" })).toEqual({ codec: "jpeg" });
  await expect.poll(() => frames.at(-1)?.header.codec).toBe("jpeg");
  await expect.poll(() => sim.avcc.length).toBe(0);
  expect(failures).toEqual([]);
});

it("a tree ref taps its element through serve-sim's touch socket; edge swipes and rotation follow the screen", async () => {
  const home = await mkdtemp(join(tmpdir(), "sim-ax-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const sim = await fakeServeSim(home, "0.1.47");
  const platform = platformFor(home);
  onTestFinished(() => platform.close());
  const capture = await startCapture({
    device,
    streamId: "native",
    fps: 30,
    platform,
    runtime,
    env: { PATH: home },
    publish: () => {},
    failure: () => {},
  });
  onTestFinished(() => capture.stop());
  if (!capture.ui || !capture.input) throw new Error("Capture has no accessibility or input");
  const tree = await capture.ui.tree({});
  const general = tree.nodes[0]?.children[0];
  expect(general).toMatchObject({ name: "General", bounds: { x: 0, y: 900, w: 1206, h: 150 } });
  const found = await capture.ui.find({ query: { name: "general" } });
  expect(found.nodes.map((node) => node.ref)).toEqual([general?.ref]);

  expect(await capture.ui.act({ ref: general?.ref, action: "press" }, () => {})).toMatchObject({
    boundsCentre: { x: 603, y: 975 },
  });
  await expect.poll(() => sim.hid.length).toBe(2);
  expect(sim.hid).toEqual([
    [3, { type: "begin", x: 0.5, y: 975 / 2622 }],
    [3, { type: "end", x: 0.5, y: 975 / 2622 }],
  ]);
  await expect(capture.ui.act({ ref: "i_stale", action: "press" }, () => {})).rejects.toThrow(
    "stale",
  );

  // A swipe up from the bottom edge is a system edge gesture (go home); a tap there is not.
  await capture.input(
    { kind: "swipe", x: 603, y: 2615, toX: 603, toY: 1300, durationMs: 16 },
    () => {},
  );
  await expect.poll(() => sim.hid.length).toBe(5);
  expect(
    sim.hid.slice(2).map((message) => (message as [number, { edge?: number }])[1].edge),
  ).toEqual([3, 3, 3]);
  await capture.input({ kind: "tap", x: 603, y: 2615 }, () => {});
  await expect.poll(() => sim.hid.length).toBe(7);
  expect(JSON.stringify(sim.hid.slice(5))).not.toContain("edge");

  await capture.input({ kind: "key", key: "rotate" }, () => {});
  await expect.poll(() => sim.hid.at(-1)).toEqual([7, { orientation: "landscape_left" }]);
});

it("a serve-sim version ace hasn't pinned is not driven", async () => {
  const home = await mkdtemp(join(tmpdir(), "sim-version-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const sim = await fakeServeSim(home, "9.9.9");
  const platform = platformFor(home);
  onTestFinished(() => platform.close());
  await expect(
    startCapture({
      device,
      streamId: "native",
      fps: 30,
      platform,
      runtime,
      env: { PATH: home },
      publish: () => {},
      failure: () => {},
    }),
  ).rejects.toMatchObject({ code: "tool_missing", message: expect.stringContaining("9.9.9") });
  expect(sim.opened()).toBe(0);
  expect(sim.mjpegOpen()).toBe(0);
});
