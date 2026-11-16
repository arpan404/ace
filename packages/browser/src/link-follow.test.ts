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

test("on a 3G link the bit rate follows it down to the floor, with no 1 Mbit/s floor", () => {
  expect(linkCapped(asked, 420_000).bitrate).toBe(400_000);
  expect(linkCapped(asked, 90_000).bitrate).toBe(150_000);
});

test("a link's step lowers the frame rate and then the size, never above the request", () => {
  expect(linkCapped(asked, 2_000_000, { scale: 1, fps: 15 })).toMatchObject({
    fps: 15,
    maxWidth: 1440,
    maxHeight: 2880,
  });
  const small = linkCapped(asked, 400_000, { scale: 0.5, fps: 5 });
  expect(small).toMatchObject({ fps: 5, maxWidth: 768, maxHeight: 1472 });
  expect(linkCapped({ ...asked, fps: 30 }, 16_000_000, { scale: 1, fps: 60 }).fps).toBe(30);
});

function following(rate: () => number, probing = false) {
  const applied: ScreenStreamSettings[] = [];
  let now = 0;
  const follow = new LinkFollow({
    link: () => ({ rate: rate(), probing }),
    now: () => now,
    apply: async (settings) => applied.push(settings),
  });
  return { follow, applied, advance: (ms: number) => (now += ms) };
}

test("following a link re-applies the request only when the cap moved by more than 15 %", async () => {
  let rate = 16_000_000;
  const { follow, applied, advance } = following(() => rate);
  await follow.ask({ ...asked, bitrate: 16_000_000 });
  expect(applied.map((s) => s.bitrate)).toEqual([16_000_000]);
  rate = 14_500_000;
  follow.tick();
  expect(applied).toHaveLength(1);
  rate = 12_000_000;
  advance(1_000);
  follow.tick();
  expect(applied.map((s) => s.bitrate)).toEqual([16_000_000, 12_000_000]);
  follow.close();
  rate = 1_000_000;
  follow.tick();
  expect(applied).toHaveLength(2);
});

test("a phone view on a thin measured link drops to 15 fps first and keeps its size", async () => {
  let rate = 16_000_000;
  const { follow, applied, advance } = following(() => rate);
  await follow.ask(asked);
  expect(applied.at(-1)).toMatchObject({ fps: 60, maxWidth: 1440 });
  rate = 3_000_000;
  advance(500);
  follow.tick();
  advance(1_000);
  follow.tick();
  expect(applied.at(-1)?.fps).toBeLessThan(60);
  expect(applied.at(-1)?.maxWidth).toBe(1440);
  rate = 400_000;
  advance(500);
  follow.tick();
  advance(1_000);
  follow.tick();
  // 15 fps of a smaller picture, still readable on its long side, rather than fewer frames.
  expect(applied.at(-1)).toMatchObject({ bitrate: 400_000, fps: 15 });
  expect(applied.at(-1)?.maxWidth).toBeLessThan(1440);
  expect(applied.at(-1)?.maxHeight).toBeGreaterThanOrEqual(1152);
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

test("a device viewer whose link slows reads as a thinner link", async () => {
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
  // Pictures the size the rate asks for, 60 a second, over a link of `megabits` and 20 ms.
  const acks: { at: number; sequence: number }[] = [];
  let linkFreeAt = 0;
  const run = async (from: number, to: number, megabits: number) => {
    for (let sequence = from; sequence <= to; sequence++) {
      const bytes = Math.round((view.rate() ?? 0) / 8 / 60);
      view.push(video(sequence, bytes));
      await new Promise((resolve) => setImmediate(resolve));
      linkFreeAt = Math.max(linkFreeAt, now) + (bytes * 8) / (megabits * 1_000);
      acks.push({ at: linkFreeAt + 20, sequence });
      now += 1000 / 60;
      while (acks[0] && acks[0].at <= now) {
        const ack = acks.shift();
        if (ack) channel.ack("device-1", "capture-1", ack.sequence);
      }
    }
  };
  // A calm, fast link: the rate climbs.
  await run(1, 180, 100);
  const calm = view.rate() ?? 0;
  expect(calm).toBeGreaterThan(pictureLinkLimits.initial);
  // Then the link carries 2 Mbit/s: the rate follows it down.
  await run(181, 720, 2);
  expect(view.rate()).toBeLessThan(calm / 2);
  view.close();
});
