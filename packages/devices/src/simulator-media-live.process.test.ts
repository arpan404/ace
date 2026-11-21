/*
 * A real Simulator through the real ace-media (X1b), opt-in: a booted Simulator set aside for
 * the purpose (ACE_DEVICE_LIVE=1, ACE_DEVICE_LIVE_IOS_UUID), ace's pinned serve-sim (downloaded
 * into a temporary tools directory), and a built ace-media (ACE_MEDIA_TEST_BINARY). What only a
 * real Simulator shows: a phone taller than a still frame opens; an agent's still of a watched
 * Simulator comes from ace-media, fresh and inside the frame's 2160-pixel height, whether
 * ace-media re-encodes the stream or passes it through; a screen that shows nothing new still
 * answers quickly; and a recording comes out as an MP4 ffmpeg decodes. ace-media's video comes
 * back on egress (no client's media connection). Safari shows pages this test serves, one
 * moving and one still. Needs ffmpeg.
 */
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import { MediaRuntime } from "@ace/media/runtime";
import { AgentId, ThreadId } from "@ace/protocol";
import { nodeMediaHost, systemMediaClock } from "@ace/media/supervisor";
import { binaryImages } from "@ace/media/testing/images";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import { DevicePlatform, DevicesService, type Device } from "./index.ts";

const execute = promisify(execFile);
const udid =
  process.env["ACE_DEVICE_LIVE"] === "1" ? process.env["ACE_DEVICE_LIVE_IOS_UUID"] : undefined;
const binary = process.env.ACE_MEDIA_TEST_BINARY?.trim() || undefined;
const ffmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const person = { kind: "human", owner: "person" } as const;
/** A phone's viewer, which ace-media re-encodes the Simulator for, and one it passes it through to. */
const viewers = [
  ["re-encoded", { codec: "h264", maxWidth: 800, maxHeight: 1600, fps: 60, bitrate: 6e6 }],
  ["passed through", { codec: "h264", maxWidth: 1440, maxHeight: 2880, fps: 60, bitrate: 12e6 }],
] as const;

/** The device's own screenshots (`simctl io screenshot`), counted. */
class CountingPlatform extends DevicePlatform {
  shots = 0;
  override screenshot(device: Device, guard?: () => void) {
    this.shots++;
    return super.screenshot(device, guard);
  }
}

/** Two pages Safari shows: one redrawn every frame, one that never changes. */
async function pages() {
  const moving = `<!doctype html><meta name=viewport content="width=device-width">
<body style="margin:0;background:#000"><div id=b style="width:100vw;height:100vh"></div>
<script>let n=0;(function f(){n++;b.style.background='hsl('+(n*7%360)+',90%,50%)';requestAnimationFrame(f)})()</script>`;
  const still = `<!doctype html><meta name=viewport content="width=device-width">
<body style="margin:0;background:#2a6"><h1>still</h1>`;
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    res.end(req.url?.startsWith("/still") ? still : moving);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${address.port}`;
  return {
    show: (page: "moving" | "still") =>
      execute("xcrun", ["simctl", "openurl", udid ?? "", `${base}/${page}?${randomUUID()}`]),
  };
}

async function service() {
  const home = await mkdtemp(join(tmpdir(), "ace-sim-media-live-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const media = new MediaRuntime({
    version: execFileSync(binary ?? "", ["--version"])
      .toString()
      .trim(),
    binary: binary ?? "",
    runtimeDir: home,
    dataDir: home,
    host: nodeMediaHost(process.env, (path) => ({ command: path, args: [] })),
    platform: process.platform,
    clock: systemMediaClock,
    random: Math.random,
    randomBytes: (length: number) => new Uint8Array(randomBytes(length)),
    id: randomUUID,
    listen: () => ({ message: { type: "listen", loopback: true }, payload: new Uint8Array(0) }),
    log: () => {},
    // ace-media reads serve-sim and hands the video back on egress, as with no client's media
    // connection (delivery is the clients' route, D1).
    capabilities: { ingest: ["simulator"], delivery: false },
  });
  onTestFinished(() => media.dispose());
  const platform = new CountingPlatform({
    platform: "darwin",
    arch: process.arch,
    home,
    env: process.env,
    toolsDirectory: join(home, "tools"),
    node: process.execPath,
    images: binaryImages(binary ?? ""),
  });
  const parts: { path: string; frames: number; width: number; height: number }[] = [];
  const devices = new DevicesService({
    platform,
    // ace's pinned serve-sim, never one on PATH.
    env: { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    runtime: {
      now: () => performance.now(),
      id: randomUUID,
      spawn: spawnRawSupervised,
      after(ms, run) {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      },
    },
    media: { attach: (producer) => media.sources.add(producer) },
    recorder: media.recordings,
    recordingDirectory: home,
    async publishArtifact(artifact) {
      let bytes = 0;
      for (const part of artifact.parts) {
        parts.push({ path: part.path, ...(await decoded(part.path)) });
        bytes += part.bytes;
      }
      return { id: artifact.id, bytes, mimeType: "video/mp4" };
    },
  });
  onTestFinished(() => devices.close());
  return { devices, platform, parts };
}

/**
 * What ffmpeg makes of an MP4: every picture decoded with no error, its decode times only ever
 * going forward, and its picture count and size.
 */
async function decoded(path: string) {
  const { stdout, stderr } = await execute("ffprobe", [
    "-v",
    "error",
    "-count_frames",
    "-count_packets",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=codec_name,width,height,nb_read_frames,nb_read_packets",
    "-of",
    "json",
    path,
  ]);
  expect(stderr).toBe("");
  const stream = (
    JSON.parse(stdout) as {
      streams: {
        codec_name: string;
        width: number;
        height: number;
        nb_read_frames: string;
        nb_read_packets: string;
      }[];
    }
  ).streams[0];
  expect(stream?.codec_name).toBe("h264");
  expect(stream?.nb_read_frames).toBe(stream?.nb_read_packets);
  const packets = await execute("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "packet=dts",
    "-of",
    "csv=p=0",
    path,
  ]);
  const dts = packets.stdout.trim().split("\n").map(Number);
  expect(dts.every((value, index) => index === 0 || value > (dts[index - 1] ?? -Infinity))).toBe(
    true,
  );
  return {
    frames: Number(stream?.nb_read_frames ?? 0),
    width: stream?.width ?? 0,
    height: stream?.height ?? 0,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it.skipIf(!udid || !binary || !ffmpeg).each(viewers)(
  "a watched real Simulator (%s): agents' stills come from ace-media inside 2160 pixels, a still screen's answer comes within a second, and its recording decodes as MP4",
  { timeout: 240_000 },
  async (mode, video) => {
    const deviceId = `ios:${udid}`;
    const page = await pages();
    await page.show("moving");
    const { devices, platform, parts } = await service();
    await devices.request({ op: "enable", enabled: true }, person);
    // An iPhone 17 Pro's 1206 × 2622 picture is taller than a still frame: it opens all the same.
    await devices.request({ op: "start", deviceId, fps: 30 }, person);
    expect(
      await devices.request({ op: "stream.configure", deviceId, settings: video }, person),
    ).toEqual({ codec: "h264" });
    await sleep(3000);

    // (a) A screen that keeps changing: each still is ace-media's, made after it was asked.
    const before = platform.shots;
    const times: number[] = [];
    for (let n = 0; n < 4; n++) {
      const asked = performance.now();
      const made = await devices.screenshot(deviceId, person);
      times.push(Math.round(performance.now() - asked));
      expect(made.header.codec).toBe("jpeg");
      expect(made.header.height).toBeLessThanOrEqual(2160);
      expect(made.header.width).toBeLessThanOrEqual(1920);
      expect(made.payload.subarray(0, 2).toString("hex")).toBe("ffd8");
      await sleep(500);
    }
    expect(platform.shots).toBe(before);
    expect(Math.max(...times)).toBeLessThan(300);

    // A screen that shows nothing new answers quickly: ace-media's re-encoder still sends
    // pictures, a passed-through serve-sim sends none, so simctl answers past the deadline.
    await page.show("still");
    await sleep(3000);
    const asked = performance.now();
    const shot = await devices.screenshot(deviceId, person);
    const took = Math.round(performance.now() - asked);
    expect(shot.header.height).toBeLessThanOrEqual(2160);
    expect(took).toBeLessThan(1000);
    const by = platform.shots > before ? "simctl" : "ace-media";
    console.log(
      `${mode}: moving stills ${times.join("/")} ms; still screen by ${by} in ${took} ms`,
    );

    // (b) A recording through ace-media while the screen moves: MP4 parts ffmpeg decodes.
    await devices.request(
      {
        op: "controller",
        deviceId,
        controller: "agent",
        threadId: ThreadId.parse("thread-1"),
        agentId: AgentId.parse("agent-1"),
      },
      person,
    );
    await devices.request({ op: "controller", deviceId, controller: "none" }, person);
    await page.show("moving");
    await devices.request({ op: "record.start", deviceId }, person);
    await sleep(4000);
    expect(await devices.request({ op: "record.stop", deviceId }, person)).toMatchObject({
      mimeType: "video/mp4",
    });
    const frames = parts.reduce((sum, part) => sum + part.frames, 0);
    expect(frames).toBeGreaterThan(30);
    console.log(
      `${mode}: recording ${JSON.stringify(parts.map((p) => [p.frames, p.width, p.height]))}`,
    );
  },
);
