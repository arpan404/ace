import type { IngestProducer } from "@ace/media/ingest-sources";
import type { ScreenStreamSettings } from "@ace/protocol";
import { expect, it } from "vitest";
import { withMediaWant } from "./media-paths.ts";

const producer = (): IngestProducer => ({
  source: "scrcpy:1",
  kind: "scrcpy",
  origin: { kind: "scrcpy", host: "127.0.0.1", port: 0 },
  deviceId: "android:emulator-5554",
  epoch: () => 0,
  consumers: { deliver: () => {} },
  point: () => Promise.resolve(),
  keyframe: () => {},
});

it("ace-media's plan for a device's views becomes that device's stream request, within its bounds", () => {
  const attached: IngestProducer[] = [];
  const asked: (ScreenStreamSettings | undefined)[] = [];
  const media = withMediaWant(
    {
      attach: (p) => {
        attached.push(p);
        return {
          streaming: () => true,
          reconnect: () => {},
          codecs: () => {},
          encodes: () => {},
          key: () => {},
          close: () => {},
        };
      },
    },
    (settings) => void asked.push(settings),
  );
  media.attach(producer());
  attached[0]?.want?.([
    { id: 0, codec: "avc1.42E033", width: 540, height: 1170, fps: 30, bitrate: 900_000 },
    { id: 1, codec: "avc1.42E033", width: 1080, height: 2340, fps: 30, bitrate: 3_000_000 },
  ]);
  // The device runs one stream: the largest wanted.
  expect(asked).toEqual([
    { codec: "h264", maxWidth: 1080, maxHeight: 2340, fps: 30, bitrate: 3_000_000 },
  ]);
  attached[0]?.want?.([
    { id: 0, codec: "avc1.42E033", width: 30, height: 60, fps: 5, bitrate: 40_000 },
  ]);
  expect(asked.at(-1)).toEqual({
    codec: "h264",
    maxWidth: 64,
    maxHeight: 64,
    fps: 5,
    bitrate: 128_000,
  });
  // No plan: ace-media's request is withdrawn.
  attached[0]?.want?.([]);
  expect(asked).toHaveLength(3);
  expect(asked.at(-1)).toBeUndefined();
});

it("ace-media's budget for a device goes with its plan, its route and its source", async () => {
  const attached: IngestProducer[] = [];
  const asked: (ScreenStreamSettings | undefined)[] = [];
  let closed = 0;
  const media = withMediaWant(
    {
      attach: (p) => {
        attached.push(p);
        return {
          streaming: () => true,
          reconnect: () => {},
          codecs: () => {},
          encodes: () => {},
          key: () => {},
          close: () => void closed++,
        };
      },
    },
    (settings) => void asked.push(settings),
  );
  const source = media.attach(producer());
  const p = attached[0];
  if (!p) throw new Error("not attached");
  const plan = [
    { id: 0, codec: "avc1.42E033", width: 540, height: 1170, fps: 30, bitrate: 900_000 },
  ];
  // An empty plan: no media viewer left, so its budget no longer holds the legacy ones back.
  p.want?.(plan);
  p.want?.([]);
  expect(asked.at(-1)).toBeUndefined();
  // Pointed back at the daemon (a route flip, ace-media gone): the same.
  p.want?.(plan);
  await p.point(undefined);
  expect(asked.at(-1)).toBeUndefined();
  // And when the source closes.
  p.want?.(plan);
  source.close();
  expect(asked.at(-1)).toBeUndefined();
  expect(closed).toBe(1);
});
