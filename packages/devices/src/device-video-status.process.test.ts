import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import type { IngestProducer } from "@ace/media/ingest-sources";
import { encodeProducerStamp } from "@ace/media/producer-stamp";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import { DevicesService } from "./index.ts";
import type { DeviceMedia } from "./media-paths.ts";
import { simulatorCapture } from "./simulator-capture.ts";
import { FakeSimPlatform } from "./testing/fake-sim.ts";
import { fakeServeSim } from "./testing/fake-serve-sim.ts";

/*
 * A device's live video comes only through ace-media (X2): its state says why when it can't
 * (`DeviceState.video`), the next picture clears that, and an agent's screenshot is never the
 * last picture from before the live view took the capture. The real devices service and
 * Simulator capture against a fake serve-sim; ace-media is a stand-in at its edge that never
 * streams unless a test hands back a unit.
 */

const ios = "ios:00000000-0000-4000-8000-00000000F00D";
const person = { kind: "human", owner: "person" } as const;
const video = {
  codec: "h264" as const,
  maxWidth: 800,
  maxHeight: 1600,
  fps: 60,
  bitrate: 12_000_000,
};

/** ace-media at the devices' edge: records each producer; nothing streams on its own. */
function standIn() {
  const producers: IngestProducer[] = [];
  const media: DeviceMedia = {
    attach: (producer) => {
      producers.push(producer);
      return {
        streaming: () => false,
        reconnect: () => {},
        codecs: () => {},
        encodes: () => {},
        key: () => {},
        picture: () => false,
        close: () => {},
      };
    },
  };
  const last = () => {
    const producer = producers.at(-1);
    if (!producer) throw new Error("no producer");
    return producer;
  };
  return {
    media,
    async stream() {
      await last().point({ url: "", socket: "", token: new Uint8Array(32), epoch: 0, path: "p1" });
    },
    stop: (reason: string, status: "retrying" | "unavailable") => last().stopped?.(reason, status),
    keyframe() {
      last().consumers.deliver({
        source: "p1",
        sequence: 0,
        gap: false,
        frame: {
          kind: 1,
          flags: 1,
          ageUs: 0,
          width: 1206,
          height: 2622,
          displayWidth: 1206,
          displayHeight: 2622,
          scale: 1000,
          rotation: 0,
          codec: 1,
          encode: 0,
          epoch: 0,
          codecString: "avc1.640033",
          description: new Uint8Array(0),
          extension: encodeProducerStamp({ sequence: 1, timestamp: 1, scale: 1 }),
          payload: new Uint8Array([0, 0, 0, 1, 0x65, 0x88]),
        },
      });
    },
  };
}

async function simulator(media: DeviceMedia | undefined) {
  const home = await mkdtemp(join(tmpdir(), "sim-video-status-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const sim = await fakeServeSim(home, "0.1.49-beta.139.1", ios.slice(4));
  const platform = new FakeSimPlatform(home);
  let id = 0;
  const service = new DevicesService({
    platform,
    env: {},
    runtime: {
      now: () => performance.now(),
      id: () => `stream-${++id}`,
      spawn: spawnRawSupervised,
      after(ms, run) {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      },
    },
    capture: (options) =>
      simulatorCapture({ ...options, command: sim.command, env: { PATH: home } }),
    ...(media ? { media } : {}),
    recordingDirectory: home,
    async publishArtifact() {
      throw new Error("Not recording");
    },
  });
  onTestFinished(() => service.close());
  await service.request({ op: "enable", enabled: true }, person);
  await service.request({ op: "start", deviceId: ios, fps: 30 }, person);
  const state = async () => service.states().find((s) => s.device.id === ios);
  return { service, platform, state };
}

it("while ace-media can't carry a device's video its state says why, and the next picture clears it", async () => {
  const ace = standIn();
  const d = await simulator(ace.media);
  await d.service.request({ op: "stream.configure", deviceId: ios, settings: video }, person);
  await ace.stream();
  ace.stop("ace-media stopped and is starting again", "retrying");
  expect((await d.state())?.video).toEqual({
    status: "retrying",
    reason: "ace-media stopped and is starting again",
  });
  ace.keyframe();
  expect((await d.state())?.video).toBeUndefined();
});

it("without ace-media a device's live view is refused and its state says why", async () => {
  const d = await simulator(undefined);
  await expect(
    d.service.request({ op: "stream.configure", deviceId: ios, settings: video }, person),
  ).rejects.toMatchObject({ code: "command_failed" });
  expect((await d.state())?.video).toEqual({
    status: "unavailable",
    reason: "ace-media isn't available on this computer",
  });
});

it("an agent's screenshot while the live view waits for ace-media's first picture is the screen now, never the last still", async () => {
  const ace = standIn();
  const d = await simulator(ace.media);
  const stale = await d.service.screenshot(ios, person);
  expect(stale.header.codec).toBe("jpeg");
  await d.service.request({ op: "stream.configure", deviceId: ios, settings: video }, person);
  // ace-media never sends a picture: the cached still is all the session has.
  const before = d.platform.shots.length;
  const shot = await d.service.screenshot(ios, person);
  expect(d.platform.shots.length).toBe(before + 1);
  expect(shot.header).toMatchObject({ codec: "jpeg", width: 300, height: 600 });
});
