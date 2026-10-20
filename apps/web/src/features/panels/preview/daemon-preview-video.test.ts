import { FakeDaemon, ScenarioPlayer, failingSubagent } from "@ace/fake-daemon";
import { waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { fakeClient } from "@/test/fake-client.ts";
import { daemonPreview } from "./daemon-preview.ts";
import { streamingClient } from "./stream-test-support.ts";
import type { VideoDecoderConfig, VideoDecoderFactory } from "@/lib/video/codecs.ts";
import type { BrowserVideoChunk } from "./thread-videos.ts";

const thread = "thread-settings";

/**
 * A decoder that decodes when told to: each chunk it was given comes out as a picture, in order.
 * A picture remembers whether it was closed, so a test sees what was freed.
 */
function fakeDecoder() {
  const configs: VideoDecoderConfig[] = [];
  const decoded: number[] = [];
  const closed = new Set<number>();
  let fail: (() => void) | undefined;
  let queue: { output(sequence: number): void; sequences: number[] } | undefined;
  const factory: VideoDecoderFactory = (handlers) => {
    const mine = {
      sequences: [] as number[],
      output: (sequence: number) =>
        handlers.output({
          sequence,
          draw() {},
          close: () => void closed.add(sequence),
        }),
    };
    queue = mine;
    fail = handlers.error;
    return {
      configure: (config) => void configs.push(config),
      decode: (chunk) => {
        decoded.push(chunk.sequence);
        mine.sequences.push(chunk.sequence);
      },
      close() {},
    };
  };
  return {
    factory,
    configs,
    decoded,
    closed,
    /** Everything given so far comes out. */
    flush() {
      const current = queue;
      if (!current) return;
      for (const sequence of current.sequences.splice(0)) current.output(sequence);
    },
    fail: () => fail?.(),
  };
}

const chunk = (sequence: number, key: boolean): BrowserVideoChunk => ({
  sequence,
  timestamp: 1000 + sequence,
  width: 390,
  height: 800,
  codedWidth: 1170,
  codedHeight: 2400,
  codec: "avc1.42E033",
  key,
  ...(key ? { description: new Uint8Array([1, 66, 224, 51]) } : {}),
  bytes: new Uint8Array([sequence]),
});

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

async function watching(options: {
  decoder?: ReturnType<typeof fakeDecoder> | null;
  codecs?: readonly string[];
  visible?: () => boolean;
}) {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  new ScenarioPlayer(daemon, failingSubagent()).step();
  daemon.browser.drive(thread, { url: "http://localhost:5173" });
  const client = fakeClient(daemon);
  await client.start();
  await waitFor(() => expect(client.state).toBe("ready"));
  const wire = streamingClient(client);
  const shown = { visible: options.visible ?? (() => true), listeners: new Set<() => void>() };
  const preview = daemonPreview(wire.api, {
    schedule: () => () => {},
    visibility: {
      visible: () => shown.visible(),
      watch: (listener) => {
        shown.listeners.add(listener);
        return () => shown.listeners.delete(listener);
      },
    },
    videoDecoder: options.decoder === null ? null : (options.decoder?.factory ?? null),
    videoSupport: () => Promise.resolve(options.codecs ?? ["avc1.42E033", "vp8"]),
  });
  const stop = preview.watch(thread);
  disposers.push(() => {
    stop();
    preview.dispose();
  });
  await preview.open(thread, failingSubagent().thread.workspaceId);
  await waitFor(() =>
    expect(wire.requests).toContainEqual(expect.objectContaining({ type: "browser.subscribe" })),
  );
  const video = (sequence: number, key: boolean) =>
    wire.stream({
      kind: "browser.video",
      threadId: ThreadId.parse(thread),
      chunk: chunk(sequence, key),
    });
  const videoAcks = () =>
    wire.sent.filter(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "browser.ack" &&
        "video" in message,
    );
  return { preview, wire, video, videoAcks, shown };
}

test("a client that decodes video asks for it with its codecs, best first", async () => {
  const { wire } = await watching({ decoder: fakeDecoder(), codecs: ["avc1.42E033", "vp8"] });
  expect(wire.requests).toContainEqual(
    expect.objectContaining({
      type: "browser.subscribe",
      binaryFrames: true,
      video: { codecs: ["avc1.42E033", "vp8"] },
    }),
  );
});

test("a client without a video decoder subscribes without video and ignores JPEG frames", async () => {
  const { wire, preview } = await watching({ decoder: null });
  const subscribe = wire.requests.find(
    (request) =>
      typeof request === "object" &&
      request !== null &&
      "type" in request &&
      request.type === "browser.subscribe",
  );
  expect(subscribe).not.toHaveProperty("video");
  expect(preview.decodesVideo?.()).toBe(false);
  wire.stream({
    kind: "browser.frame",
    threadId: ThreadId.parse(thread),
    frame: {
      sequence: 3,
      timestamp: 1,
      width: 390,
      height: 800,
      bytes: new Uint8Array([255, 216]),
    },
  });
  await Promise.resolve();
  expect(preview.frame(thread)).toBeUndefined();
  expect(wire.sent).not.toContainEqual(expect.objectContaining({ type: "browser.ack" }));
});

test("a client whose decoder plays none of the codecs subscribes without video", async () => {
  const { wire, preview } = await watching({ decoder: fakeDecoder(), codecs: [] });
  const subscribe = wire.requests.find(
    (request) =>
      typeof request === "object" &&
      request !== null &&
      "type" in request &&
      request.type === "browser.subscribe",
  );
  expect(subscribe).not.toHaveProperty("video");
  expect(preview.decodesVideo?.()).toBe(false);
});

test("a client that plays a codec says it decodes video", async () => {
  const { preview } = await watching({ decoder: fakeDecoder() });
  expect(preview.decodesVideo?.()).toBe(true);
});

test("a keyframe and its deltas are decoded, shown at device pixels and acked as video", async () => {
  const decoder = fakeDecoder();
  const { preview, video, videoAcks } = await watching({ decoder });
  video(10, true);
  video(11, false);
  expect(decoder.configs).toEqual([
    {
      codec: "avc1.42E033",
      codedWidth: 1170,
      codedHeight: 2400,
      description: new Uint8Array([1, 66, 224, 51]),
    },
  ]);
  decoder.flush();
  expect(preview.frame(thread)).toMatchObject({
    sequence: 11,
    width: 390,
    height: 800,
    codedWidth: 1170,
    codedHeight: 2400,
  });
  // The picture it replaced is freed.
  expect([...decoder.closed]).toEqual([10]);
  expect(videoAcks()).toEqual([
    expect.objectContaining({ sequence: 10, video: true }),
    expect.objectContaining({ sequence: 11, video: true }),
  ]);
  expect(videoAcks()).not.toContainEqual(expect.objectContaining({ keyframe: true }));
});

test("deltas before any keyframe are skipped but acked, so the daemon's window frees", async () => {
  const decoder = fakeDecoder();
  const { preview, video, videoAcks } = await watching({ decoder });
  video(4, false);
  expect(decoder.decoded).toEqual([]);
  expect(preview.frame(thread)).toBeUndefined();
  expect(videoAcks()).toEqual([expect.objectContaining({ sequence: 4, video: true })]);
});

test("a decode error asks for a keyframe and skips deltas until one arrives", async () => {
  const decoder = fakeDecoder();
  const { preview, video, videoAcks } = await watching({ decoder });
  video(1, true);
  decoder.flush();
  video(2, false);
  decoder.fail();
  expect(videoAcks().at(-1)).toEqual(
    expect.objectContaining({ sequence: 2, video: true, keyframe: true }),
  );
  video(3, false);
  expect(decoder.decoded).toEqual([1, 2]);
  video(4, true);
  decoder.flush();
  expect(decoder.decoded).toEqual([1, 2, 4]);
  expect(preview.frame(thread)?.sequence).toBe(4);
  // A fresh decoder is configured from the new keyframe.
  expect(decoder.configs).toHaveLength(2);
});

test("a hidden page owes its video acks until it shows again", async () => {
  const decoder = fakeDecoder();
  let visible = true;
  const { video, videoAcks, shown } = await watching({ decoder, visible: () => visible });
  visible = false;
  video(7, true);
  video(8, false);
  decoder.flush();
  expect(videoAcks()).toEqual([]);
  visible = true;
  for (const listener of shown.listeners) listener();
  expect(videoAcks()).toEqual([expect.objectContaining({ sequence: 8, video: true })]);
});

test("a JPEG frame after video is ignored: the picture stays and the video carries on", async () => {
  const decoder = fakeDecoder();
  const { preview, wire, video, videoAcks } = await watching({ decoder });
  video(1, true);
  decoder.flush();
  wire.stream({
    kind: "browser.frame",
    threadId: ThreadId.parse(thread),
    frame: { sequence: 50, timestamp: 1, width: 390, height: 800, bytes: new Uint8Array([255]) },
  });
  await Promise.resolve();
  expect(preview.frame(thread)?.sequence).toBe(1);
  expect(decoder.closed.has(1)).toBe(false);
  video(2, false);
  decoder.flush();
  expect(decoder.decoded).toEqual([1, 2]);
  expect(videoAcks()).not.toContainEqual(expect.objectContaining({ sequence: 50 }));
});

test("same-sized pictures replace each other without a change to the views; a new size is one", async () => {
  const decoder = fakeDecoder();
  const { preview, wire, video } = await watching({ decoder });
  let changes = 0;
  const stop = preview.subscribe(() => changes++, thread);
  video(1, true);
  decoder.flush();
  const shown = preview.frame(thread);
  expect(changes).toBe(1);
  let drawn = 0;
  shown?.subscribe(() => drawn++);
  video(2, false);
  video(3, false);
  decoder.flush();
  // The same picture object, holding the newest picture; the one before is freed.
  expect(preview.frame(thread)).toBe(shown);
  expect(shown?.sequence).toBe(3);
  expect([...decoder.closed]).toEqual([1, 2]);
  expect(drawn).toBe(2);
  expect(changes).toBe(1);
  wire.stream({
    kind: "browser.video",
    threadId: ThreadId.parse(thread),
    chunk: { ...chunk(4, true), width: 800, height: 600, codedWidth: 1600, codedHeight: 1200 },
  });
  decoder.flush();
  expect(preview.frame(thread)).not.toBe(shown);
  expect(preview.frame(thread)).toMatchObject({ sequence: 4, width: 800, codedWidth: 1600 });
  expect(changes).toBe(2);
  stop();
});

test("a reconnect keeps the last picture until the new stream's first keyframe replaces it", async () => {
  const decoder = fakeDecoder();
  const { preview, wire, video } = await watching({ decoder });
  video(1, true);
  decoder.flush();
  const client = wire.api;
  client.networkOnline(false);
  client.networkOnline(true);
  await waitFor(() => expect(client.state).toBe("ready"));
  expect(preview.frame(thread)?.sequence).toBe(1);
  // The new stream's deltas can't be decoded before its keyframe.
  video(2, false);
  expect(decoder.decoded).toEqual([1]);
  video(3, true);
  decoder.flush();
  expect(preview.frame(thread)?.sequence).toBe(3);
});

test("a keyframe reconfigures the decoder only when its codec, size or description changed", async () => {
  const decoder = fakeDecoder();
  const { wire, video } = await watching({ decoder });
  video(1, true);
  video(2, true);
  expect(decoder.configs).toHaveLength(1);
  wire.stream({
    kind: "browser.video",
    threadId: ThreadId.parse(thread),
    chunk: { ...chunk(3, true), codedWidth: 780, codedHeight: 1600 },
  });
  expect(decoder.configs.map((config) => config.codedWidth)).toEqual([1170, 780]);
});
