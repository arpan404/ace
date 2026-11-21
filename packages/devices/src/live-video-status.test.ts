import { expect, it, onTestFinished } from "vitest";
import type { IngestProducer } from "@ace/media/ingest-sources";
import { framePacket, type Frame } from "@ace/screen";
import type { DeviceCapture } from "./capture.ts";
import { DevicePlatform, DevicesService } from "./index.ts";
import type { DeviceMedia } from "./media-paths.ts";

/*
 * A device's controls don't wait on its video: a live view whose video can't reach ace-media
 * yet still opens, keeping the device's control, with its state saying why. The reason clears at
 * the first picture the session takes from its current capture, whichever ace-media source
 * carried it. The capture is a stand-in at its boundary; the devices service is real.
 */

const deviceId = "android:Pixel";
const person = { kind: "human", owner: "person" } as const;

function frame(sequence: number): Frame {
  const header = {
    version: 1 as const,
    sessionId: "stream-1",
    sequence,
    timestamp: sequence,
    width: 1080,
    height: 2400,
    codec: "h264" as const,
    keyframe: true,
    bytes: 4,
  };
  const payload = Buffer.from([0, 0, 1, 0x65]);
  return { header, payload, packet: framePacket(header, payload) };
}

function service() {
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
  const platform = new DevicePlatform({ platform: "linux", home: "/unused", env: {} });
  platform.list = async () => [
    { id: deviceId, name: "Pixel", platform: "android", state: "booted" },
  ];
  let capture: { publish(frame: Frame): void; media: DeviceMedia } | undefined;
  const opened = Promise.withResolvers<void>();
  /** What the capture does once it holds the device's control, before any video. */
  let onOpen: (open: NonNullable<typeof capture>) => void = () => {};
  let ids = 0;
  const devices = new DevicesService({
    cowork: false,
    platform,
    env: {},
    recordingDirectory: "/unused",
    publishArtifact: async () => {},
    media,
    runtime: {
      now: () => performance.now(),
      id: () => `stream-${++ids}`,
      // The capture's deadlines, a hundred times shorter.
      after(ms, run) {
        const timer = setTimeout(run, ms / 100);
        return () => clearTimeout(timer);
      },
      spawn() {
        throw new Error("Unexpected native capture");
      },
    },
    capture: async (options): Promise<DeviceCapture> => {
      if (!options.media) throw new Error("no media");
      capture = { publish: (f) => options.publish(f), media: options.media };
      onOpen(capture);
      opened.resolve();
      return { stop: async () => {}, streamId: options.streamId };
    },
  });
  onTestFinished(() => devices.close());
  return {
    devices,
    producers,
    opened: opened.promise,
    onOpen: (run: typeof onOpen) => void (onOpen = run),
    capture: () => {
      if (!capture) throw new Error("no capture");
      return capture;
    },
    state: () => devices.states().find((s) => s.device.id === deviceId),
  };
}

const source = (media: DeviceMedia) =>
  media.attach({
    source: "scrcpy:stream-1",
    kind: "scrcpy",
    origin: { kind: "scrcpy", host: "127.0.0.1", port: 0 },
    deviceId,
    epoch: () => 0,
    consumers: { deliver: () => {} },
    point: () => Promise.resolve(),
    keyframe: () => {},
  });

it("a live view whose video ace-media can't take yet opens with the device's control, its state saying why", async () => {
  const d = service();
  await d.devices.request({ op: "enable", enabled: true }, person);
  // ace-media is down as the capture opens: its source is told so, and no picture comes.
  d.onOpen((open) => {
    source(open.media);
    d.producers.at(-1)?.stopped?.("ace-media is starting again", "retrying");
  });
  await d.devices.request({ op: "start", deviceId, fps: 30 }, person);
  // Past the first-picture deadline, the view is still live and holds the device.
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(d.state()).toMatchObject({
    lifecycle: "live",
    video: { status: "retrying", reason: "ace-media is starting again" },
  });
  expect(d.state()?.error).toBeUndefined();
});

it("a reason from a source since reopened clears at the session's next picture, from the new source", async () => {
  const d = service();
  await d.devices.request({ op: "enable", enabled: true }, person);
  const starting = d.devices.request({ op: "start", deviceId, fps: 30 }, person);
  await d.opened;
  d.capture().publish(frame(1));
  await starting;
  // The first source stops; its capture opens another for the next path.
  source(d.capture().media);
  d.producers.at(-1)?.stopped?.("ace-media is starting again", "retrying");
  expect(d.state()?.video).toMatchObject({ status: "retrying" });
  source(d.capture().media);
  d.capture().publish(frame(2));
  expect(d.state()?.video).toBeUndefined();
});
