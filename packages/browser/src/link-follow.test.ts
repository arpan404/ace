import type { ScreenStreamSettings } from "@ace/protocol";
import { expect, test } from "vitest";
import { LinkFollow, linkCapped, pictureLinkLimits } from "./link-follow.ts";
import { PictureChannel, type CapturedPicture } from "./picture-channel.ts";
import { streamKinds } from "./stream-envelope.ts";

const asked: ScreenStreamSettings = {
  codec: "h264",
  maxWidth: 1440,
  maxHeight: 2880,
  fps: 60,
  bitrate: 8_000_000,
};

test("a view's bit rate is held to what its link carries, never above what the view asked", () => {
  expect(linkCapped(asked, 3_100_000)).toEqual({ ...asked, bitrate: 3_000_000 });
  expect(linkCapped(asked, 30_000_000)).toEqual(asked);
  // Until the link is known, or for stills, the request stands.
  expect(linkCapped(asked, undefined)).toEqual(asked);
  const stills = { ...asked, codec: "jpeg" as const };
  expect(linkCapped(stills, 1_000_000)).toEqual(stills);
});

test("following a link re-applies the request only when the cap moved by more than 15 %", async () => {
  let rate = 6_000_000;
  const applied: number[] = [];
  const follow = new LinkFollow({
    rate: () => rate,
    apply: async (settings) => applied.push(settings.bitrate),
  });
  await follow.ask(asked);
  expect(applied).toEqual([6_000_000]);
  rate = 5_500_000;
  follow.tick();
  expect(applied).toEqual([6_000_000]);
  rate = 2_000_000;
  follow.tick();
  expect(applied).toEqual([6_000_000, 2_000_000]);
  // The link recovers past the view's own ceiling: the request comes back whole.
  rate = 20_000_000;
  follow.tick();
  expect(applied).toEqual([6_000_000, 2_000_000, 8_000_000]);
  follow.close();
  rate = 1_000_000;
  follow.tick();
  expect(applied).toHaveLength(3);
});

function video(sequence: number, bytes = 40_000): CapturedPicture {
  return {
    sequence,
    timestamp: sequence,
    width: 720,
    height: 1600,
    scale: 3,
    rotation: 0,
    codec: "avc1.640033",
    key: sequence === 1,
    codecNamed: sequence === 1,
    streamId: "capture-1",
    bytes: new Uint8Array(bytes),
  };
}

test("a device viewer whose acks come back slower and slower reads as a thinner link", async () => {
  let now = 0;
  const channel = new PictureChannel(streamKinds.deviceFrame, {
    transport: { bufferedBytes: () => 0, write: async () => {} },
    now: () => now,
    after: () => () => {},
    failed: () => {},
  });
  const view = channel.open("device-1", {
    keyframe: () => {},
    guard: () => {},
    link: pictureLinkLimits,
  });
  expect(view.rate()).toBe(pictureLinkLimits.initial);
  // A calm second: each 40 KB picture is acked 20 ms after it went out, and the rate climbs.
  const acks: { at: number; sequence: number }[] = [];
  const run = async (from: number, to: number, delay: (sequence: number) => number) => {
    for (let sequence = from; sequence <= to; sequence++) {
      view.push(video(sequence));
      await Promise.resolve();
      acks.push({ at: now + delay(sequence), sequence });
      now += 1000 / 60;
      while (acks[0] && acks[0].at <= now) {
        const ack = acks.shift();
        if (ack) channel.ack("device-1", "capture-1", ack.sequence);
      }
    }
  };
  await run(1, 60, () => 20);
  const calm = view.rate() ?? 0;
  expect(calm).toBeGreaterThan(pictureLinkLimits.initial);
  // Then a queue builds: every ack comes back later than the one before.
  await run(61, 180, (sequence) => 20 + (sequence - 60) * 8);
  expect(view.rate()).toBeLessThan(calm);
  view.close();
});
