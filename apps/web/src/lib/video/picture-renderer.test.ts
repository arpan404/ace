import { expect, test } from "vitest";
import type { VideoDecoderFactory } from "./codecs.ts";
import { pictureRenderer, type LivePicture } from "./picture-renderer.ts";

const picture = (
  sequence: number,
  options: Partial<Pick<LivePicture, "key" | "codec" | "streamId">> = {},
): LivePicture => ({
  streamId: options.streamId ?? "capture-1",
  sequence,
  timestamp: sequence,
  width: 720,
  height: 1600,
  codec: options.codec ?? "avc1.640028",
  key: options.key ?? false,
  bytes: new Uint8Array([sequence]),
});

/** A renderer over a stand-in decoder: `broken` decoders report every chunk as an error. */
function setup(decoder: "decodes" | "broken" | "unsupported" | "none" = "decodes") {
  const shown: number[] = [];
  const acks: { sequence: number; keyframe: boolean }[] = [];
  const events: string[] = [];
  const factory: VideoDecoderFactory = (handlers) => ({
    configure: () => events.push("configured"),
    decode: (chunk) => {
      if (decoder === "decodes")
        handlers.output({ sequence: chunk.sequence, draw: () => {}, close: () => {} });
      else handlers.error(decoder === "unsupported");
    },
    close: () => {},
  });
  const renderer = pictureRenderer<LivePicture>({
    decoder: decoder === "none" ? undefined : factory,
    show: (_image, shown_) => shown.push(shown_.sequence),
    ack: (target, keyframe) => acks.push({ sequence: target.sequence, keyframe }),
    fallback: () => events.push("fallback"),
    pressure: () => events.push("pressure"),
  });
  return { renderer, shown, acks, events };
}

test("video pictures show from a keyframe on, each acked once shown", async () => {
  const view = setup();
  await view.renderer.render(picture(1, { key: true }));
  await view.renderer.render(picture(2));
  await view.renderer.render(picture(3));
  expect(view.shown).toEqual([1, 2, 3]);
  expect(view.acks).toEqual([1, 2, 3].map((sequence) => ({ sequence, keyframe: false })));
});

test("a delta after a gap waits for a keyframe, asked for through the ack", async () => {
  const view = setup();
  await view.renderer.render(picture(1, { key: true }));
  await view.renderer.render(picture(3));
  await view.renderer.render(picture(4));
  expect(view.shown).toEqual([1]);
  expect(view.acks.slice(1)).toEqual([
    { sequence: 3, keyframe: true },
    { sequence: 4, keyframe: false },
  ]);
  await view.renderer.render(picture(5, { key: true }));
  expect(view.shown).toEqual([1, 5]);
});

test("a codec the platform refuses says so at once, and later pictures are acked unshown", async () => {
  const view = setup("unsupported");
  await view.renderer.render(picture(1, { key: true }));
  expect(view.events.filter((event) => event === "fallback")).toHaveLength(1);
  // Video still in flight after that is acked without showing, so the daemon's window drains.
  await view.renderer.render(picture(2));
  expect(view.acks.at(-1)).toEqual({ sequence: 2, keyframe: false });
  expect(view.shown).toEqual([]);
});

test("a decoder that keeps failing gives up on video after three tries", async () => {
  const view = setup("broken");
  for (let sequence = 1; sequence <= 3; sequence++)
    await view.renderer.render(picture(sequence, { key: true }));
  expect(view.events.filter((event) => event === "fallback")).toHaveLength(1);
  expect(view.acks.slice(0, 2)).toEqual([
    { sequence: 1, keyframe: true },
    { sequence: 2, keyframe: true },
  ]);
});

test("without WebCodecs, the view says it can't show video and acks pictures unshown", async () => {
  const view = setup("none");
  await view.renderer.render(picture(1, { key: true }));
  expect(view.events).toContain("fallback");
  expect(view.acks).toEqual([{ sequence: 1, keyframe: false }]);
  expect(view.shown).toEqual([]);
});

test("a new capture starts over: its sequence may begin lower than the last one's", async () => {
  const view = setup();
  await view.renderer.render(picture(90, { key: true }));
  await view.renderer.render(picture(1, { key: true, streamId: "capture-2" }));
  await view.renderer.render(picture(2, { streamId: "capture-2" }));
  expect(view.shown).toEqual([90, 1, 2]);
});

test("a still that reaches a live view is acked, never drawn, and the video keeps its place", async () => {
  const shown: number[] = [];
  const acks: { sequence: number; keyframe: boolean }[] = [];
  const renderer = pictureRenderer<LivePicture>({
    decoder: (handlers) => ({
      configure: () => {},
      decode: (chunk) =>
        handlers.output({ sequence: chunk.sequence, draw: () => {}, close: () => {} }),
      close: () => {},
    }),
    show: (_image, shown_) => shown.push(shown_.sequence),
    ack: (target, keyframe) => acks.push({ sequence: target.sequence, keyframe }),
    fallback: () => {},
    pressure: () => {},
  });
  await renderer.render(picture(1, { key: true }));
  await renderer.render(picture(2, { codec: "jpeg", key: true }));
  await renderer.render(picture(3));
  expect(shown).toEqual([1, 3]);
  expect(acks).toEqual([1, 2, 3].map((sequence) => ({ sequence, keyframe: false })));
});

test("paced to the display, a burst draws only its newest picture at the refresh, acking and freeing the rest", async () => {
  const shown: number[] = [];
  const acks: number[] = [];
  const closed: number[] = [];
  const refreshes: (() => void)[] = [];
  const renderer = pictureRenderer<LivePicture>({
    decoder: (handlers) => ({
      configure: () => {},
      decode: (chunk) =>
        handlers.output({
          sequence: chunk.sequence,
          draw: () => {},
          close: () => closed.push(chunk.sequence),
        }),
      close: () => {},
    }),
    show: (_image, target) => shown.push(target.sequence),
    ack: (target) => acks.push(target.sequence),
    fallback: () => {},
    pressure: () => {},
    nextFrame: (draw) => {
      refreshes.push(draw);
      return () => {};
    },
  });
  // Pictures held up by a stalled link arrive together, between two refreshes.
  await renderer.render(picture(1, { key: true }));
  for (let sequence = 2; sequence <= 5; sequence++) await renderer.render(picture(sequence));
  // Every decoded picture frees the daemon's window at once; none is drawn before the refresh.
  expect(acks).toEqual([1, 2, 3, 4, 5]);
  expect(shown).toEqual([]);
  expect(closed).toEqual([1, 2, 3, 4]);
  expect(refreshes).toHaveLength(1);
  refreshes.shift()?.();
  expect(shown).toEqual([5]);
  expect(closed).toEqual([1, 2, 3, 4, 5]);
  await renderer.render(picture(6));
  refreshes.shift()?.();
  expect(shown).toEqual([5, 6]);
  renderer.close();
});

interface TurnedPicture extends LivePicture {
  rotation: number;
  scale: number;
}

/** A renderer whose decoder holds every chunk until the test releases its picture. */
function delayedSetup() {
  const shown: Pick<TurnedPicture, "sequence" | "timestamp" | "rotation" | "scale">[] = [];
  const acks: { sequence: number; timestamp: number; keyframe: boolean }[] = [];
  const decoders: { output: (sequence: number) => void }[] = [];
  const renderer = pictureRenderer<TurnedPicture>({
    decoder: (handlers) => {
      decoders.push({
        output: (sequence) => handlers.output({ sequence, draw: () => {}, close: () => {} }),
      });
      return { configure: () => {}, decode: () => {}, close: () => {} };
    },
    show: (_image, target) =>
      shown.push({
        sequence: target.sequence,
        timestamp: target.timestamp,
        rotation: target.rotation,
        scale: target.scale,
      }),
    ack: (target, keyframe) =>
      acks.push({ sequence: target.sequence, timestamp: target.timestamp, keyframe }),
    fallback: () => {},
    pressure: () => {},
  });
  const turned = (
    sequence: number,
    rotation: number,
    options: { key?: boolean; streamId?: string; timestamp?: number; scale?: number } = {},
  ): TurnedPicture => ({
    ...picture(sequence, { key: options.key ?? false, streamId: options.streamId ?? "capture-1" }),
    timestamp: options.timestamp ?? sequence * 1000,
    rotation,
    scale: options.scale ?? 1,
  });
  return { renderer, shown, acks, decoders, turned };
}

test("a picture the decoder hands back late is shown with its own time, rotation and scale", async () => {
  const view = delayedSetup();
  await view.renderer.render(view.turned(1, 0, { key: true, scale: 3 }));
  await view.renderer.render(view.turned(2, 90, { scale: 2 }));
  view.decoders[0]?.output(1);
  expect(view.shown).toEqual([{ sequence: 1, timestamp: 1000, rotation: 0, scale: 3 }]);
  expect(view.acks).toEqual([{ sequence: 1, timestamp: 1000, keyframe: false }]);
  view.decoders[0]?.output(2);
  expect(view.shown.at(-1)).toEqual({ sequence: 2, timestamp: 2000, rotation: 90, scale: 2 });
});

test("a late picture from before a new capture is never shown with the new capture's details", async () => {
  const view = delayedSetup();
  await view.renderer.render(view.turned(1, 0, { key: true }));
  await view.renderer.render(view.turned(1, 270, { key: true, streamId: "capture-2" }));
  // The first capture's decoder answers after the switch: dropped, not drawn as capture 2's.
  view.decoders[0]?.output(1);
  expect(view.shown).toEqual([]);
  view.decoders.at(-1)?.output(1);
  expect(view.shown).toEqual([{ sequence: 1, timestamp: 1000, rotation: 270, scale: 1 }]);
});
