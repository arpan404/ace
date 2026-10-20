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
    image: async () => ({ draw: () => {}, close: () => events.push("image closed") }),
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

test("a codec the platform refuses falls back to JPEG at once; JPEGs show and are freed", async () => {
  const view = setup("unsupported");
  await view.renderer.render(picture(1, { key: true }));
  expect(view.events.filter((event) => event === "fallback")).toHaveLength(1);
  // Video still in flight before the switch is acked without showing, so the window drains.
  await view.renderer.render(picture(2));
  expect(view.acks.at(-1)).toEqual({ sequence: 2, keyframe: false });
  await view.renderer.render(picture(3, { codec: "jpeg", key: true }));
  expect(view.shown).toEqual([3]);
  expect(view.events).toContain("image closed");
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

test("without WebCodecs, H.264 pictures ask for JPEG and are acked unshown", async () => {
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
