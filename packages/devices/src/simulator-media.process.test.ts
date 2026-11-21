/*
 * A Simulator through ace-media (E3b) against the real binary: ace-media reads serve-sim's
 * `/stream.avcc` itself (here a fake serve-sim, a real HTTP server sending real records) and
 * its units come back on egress to the capture, which publishes them as it does serve-sim's
 * today. What only the binary can show: its HTTP reading and record decoding on a real socket,
 * a keyframe at each switch, and the daemon reading serve-sim again within 2 s of ace-media
 * being killed. Runs when ACE_MEDIA_TEST_BINARY names a built ace-media.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { MediaRuntime } from "@ace/media/runtime";
import { nodeMediaHost, systemMediaClock, type MediaSettings } from "@ace/media/supervisor";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import type { Frame } from "@ace/screen";
import { DevicePlatform, startCapture, type DeviceRuntime } from "./index.ts";
import { fakeServeSim } from "./testing/fake-serve-sim.ts";

const binary = process.env.ACE_MEDIA_TEST_BINARY?.trim() || undefined;
const udid = "11111111-1111-4111-8111-111111111111";

async function until(condition: () => boolean, ms = 15_000): Promise<void> {
  const end = performance.now() + ms;
  while (!condition()) {
    if (performance.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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
  now: () => performance.now(),
  id: () => "native",
  spawn: spawnRawSupervised,
  after(ms, run) {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

it.runIf(!!binary)(
  "a Simulator is read by ace-media and comes back on egress as today's frames, each switch starts at a keyframe with nothing repeated, and a killed ace-media hands the reading back within 2 s",
  { timeout: 120_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "ace-e3b-sim-"));
    onTestFinished(() => rm(home, { recursive: true, force: true }));
    const sim = await fakeServeSim(home, "0.1.49-beta.139.1", udid);
    const platform = platformFor(home);
    onTestFinished(() => platform.close());

    const settings: MediaSettings = {
      encode: "auto",
      delivery: "auto",
      recordings: "legacy",
      stills: "legacy",
    };
    const media = new MediaRuntime({
      version: execFileSync(binary ?? "", ["--version"])
        .toString()
        .trim(),
      binary: binary ?? "",
      runtimeDir: home,
      dataDir: home,
      settings: () => settings,
      host: nodeMediaHost(process.env, (path) => ({ command: path, args: [] })),
      clock: systemMediaClock,
      random: Math.random,
      randomBytes: (length: number) => new Uint8Array(randomBytes(length)),
      id: randomUUID,
      listen: () => ({ message: { type: "listen", loopback: true }, payload: new Uint8Array(0) }),
      log: () => {},
      capabilities: { ingest: ["simulator"], recordings: false, stills: false, delivery: false },
    });
    onTestFinished(() => media.dispose());

    // Units come back on egress synchronously into the capture's publish: a frame published
    // while one is being delivered came from ace-media.
    let fromEgress = false;
    const published: { frame: Frame; egress: boolean; at: number }[] = [];
    const capture = await startCapture({
      device: { id: `ios:${udid}`, name: "iPhone", platform: "ios", state: "booted" },
      streamId: "native",
      fps: 30,
      platform,
      runtime,
      env: { PATH: home },
      publish: (frame) => void published.push({ frame, egress: fromEgress, at: performance.now() }),
      failure: () => {},
      media: {
        attach: (producer) =>
          media.sources.add({
            ...producer,
            consumers: {
              ...producer.consumers,
              record: (unit) => {
                fromEgress = true;
                try {
                  producer.consumers.record(unit);
                } finally {
                  fromEgress = false;
                }
              },
            },
          }),
      },
    });
    onTestFinished(() => capture.stop());
    expect(
      // A viewer box the Simulator fits: serve-sim's stream passes through (re-encoding for a
      // smaller one is simulator-transcode-media's).
      await capture.configure?.({
        codec: "h264",
        maxWidth: 1600,
        maxHeight: 3200,
        fps: 60,
        bitrate: 12_000_000,
      }),
    ).toEqual({ codec: "h264" });

    // serve-sim sends a delta every 20 ms, each marked with its number.
    let mark = 0;
    const timer = setInterval(() => sim.delta(++mark & 0xff), 20);
    onTestFinished(() => clearInterval(timer));
    const video = () => published.filter((entry) => entry.frame.header.codec === "h264");

    await until(() => video().some((entry) => entry.egress && entry.frame.header.keyframe));
    expect(media.supervisor.health()).toBe("healthy");
    // Today's header, field for field, though ace-media read it.
    const key = video().find((entry) => entry.egress && entry.frame.header.keyframe)?.frame;
    expect(key?.header).toMatchObject({
      codec: "h264",
      keyframe: true,
      videoCodec: "avc1.640033",
      width: 1206,
      height: 2622,
      scale: 1,
    });
    expect(key?.payload.subarray(0, 4).toString("hex")).toBe("00000001");

    for (const encode of ["legacy", "auto", "legacy", "auto"] as const) {
      const flipped = performance.now();
      settings.encode = encode;
      media.settingsChanged();
      await until(
        () =>
          video().filter((entry) => entry.at > flipped && entry.egress === (encode === "auto"))
            .length >= 5,
      );
    }
    // Each path change starts at a keyframe, and serve-sim's deltas only ever move forward: none
    // is published twice, whichever subscriptions carried it.
    const frames = video();
    for (const [index, entry] of frames.entries())
      if (index > 0 && entry.egress !== frames[index - 1]?.egress)
        expect(entry.frame.header.keyframe).toBe(true);
    const deltas = frames
      .filter((entry) => !entry.frame.header.keyframe)
      .map((entry) => entry.frame.payload.at(-1) ?? 0);
    const wraps = deltas.filter((value, index) => index > 0 && value <= (deltas[index - 1] ?? 0));
    expect(wraps.length).toBeLessThanOrEqual(Math.floor(mark / 256));
    // The capture numbers what it publishes as before.
    const sequences = published.map((entry) =>
      entry.frame.header.version === 1 ? entry.frame.header.sequence : -1,
    );
    expect(sequences).toEqual(sequences.map((_, index) => index));

    const pid = media.supervisor.snapshot().pid ?? 0;
    expect(pid).toBeGreaterThan(0);
    const killed = performance.now();
    process.kill(pid, "SIGKILL");
    await until(() => video().some((entry) => entry.at > killed && !entry.egress), 5_000);
    const back = video().find((entry) => entry.at > killed && !entry.egress);
    expect((back?.at ?? Infinity) - killed).toBeLessThan(2_000);
    expect(back?.frame.header.keyframe).toBe(true);
  },
);
