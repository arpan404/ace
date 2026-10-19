import { FakeDaemon, ScenarioPlayer, failingSubagent } from "@ace/fake-daemon";
import { waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { fakeClient } from "@/test/fake-client.ts";
import type { AudioDecoderFactory, AudioOutputFactory, DecodedSound } from "./audio-codecs.ts";
import { bufferMs } from "./av-sync.ts";
import { daemonPreview } from "./daemon-preview.ts";
import { streamingClient } from "./stream-test-support.ts";
import type { VideoDecoderFactory } from "./video-codecs.ts";

const thread = "thread-settings";

/** Pictures come out as soon as they go in. */
const videoDecoder: VideoDecoderFactory = (handlers) => ({
  configure() {},
  decode: (chunk) => handlers.output({ sequence: chunk.sequence, draw() {}, close() {} }),
  close() {},
});

/** Opus packets decode at once into 20 ms of sound stamped like their chunk. */
function fakeSound() {
  const decoded: number[] = [];
  const played: { timestamp: number; at: number }[] = [];
  let opened = 0;
  let closed = 0;
  const decoder: AudioDecoderFactory = (handlers) => ({
    configure() {},
    decode: (chunk) => {
      decoded.push(chunk.timestamp);
      const sound: DecodedSound = {
        timestamp: chunk.timestamp,
        frames: 960,
        sampleRate: 48_000,
        channels: 2,
        copy() {},
        close() {},
      };
      handlers.output(sound);
    },
    close() {},
  });
  const output: AudioOutputFactory = () => {
    opened++;
    return {
      play: (sound, at) => void played.push({ timestamp: sound.timestamp, at }),
      close: () => void closed++,
    };
  };
  return {
    decoder,
    output,
    decoded,
    played,
    opened: () => opened,
    closed: () => closed,
  };
}

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

async function watching(sound: ReturnType<typeof fakeSound> | null) {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  new ScenarioPlayer(daemon, failingSubagent()).step();
  daemon.browser.drive(thread, { url: "http://localhost:5173" });
  const client = fakeClient(daemon);
  await client.start();
  await waitFor(() => expect(client.state).toBe("ready"));
  const wire = streamingClient(client);
  const clock = { now: 50_000 };
  const preview = daemonPreview(wire.api, {
    schedule: () => () => {},
    visibility: { visible: () => true, watch: () => () => {} },
    videoDecoder,
    videoSupport: () => Promise.resolve(["avc1.42E033"]),
    audioDecoder: sound?.decoder ?? null,
    audioOutput: sound?.output ?? null,
    clock: () => clock.now,
  });
  preview.capture?.(thread, 390, 800, 3);
  const stop = preview.watch(thread);
  disposers.push(() => {
    stop();
    preview.dispose();
  });
  await preview.open(thread, failingSubagent().thread.workspaceId);
  await waitFor(() =>
    expect(wire.requests).toContainEqual(expect.objectContaining({ type: "browser.subscribe" })),
  );
  const threadId = ThreadId.parse(thread);
  return {
    preview,
    wire,
    clock,
    /** A keyframe captured at `timestamp` on the daemon's clock. */
    picture: (sequence: number, timestamp: number) =>
      wire.stream({
        kind: "browser.video",
        threadId,
        chunk: {
          sequence,
          timestamp,
          width: 390,
          height: 800,
          codedWidth: 1170,
          codedHeight: 2400,
          codec: "avc1.42E033",
          key: true,
          bytes: new Uint8Array([sequence]),
        },
      }),
    /** 20 ms of sound captured at `timestamp`. */
    sound: (sequence: number, timestamp: number) =>
      wire.stream({
        kind: "browser.audio",
        threadId,
        chunk: {
          sequence,
          timestamp,
          sampleRate: 48_000,
          channels: 2,
          codec: "opus",
          bytes: new Uint8Array([sequence]),
        },
      }),
    /** What this viewer last told the daemon it shows and hears. */
    viewport: () =>
      wire.requests.flatMap((request) =>
        typeof request === "object" &&
        request !== null &&
        "viewport" in request &&
        typeof request.viewport === "object" &&
        request.viewport !== null
          ? [request.viewport]
          : [],
      ),
  };
}

test("a view starts muted: it asks for no sound and plays none that arrives", async () => {
  const sound = fakeSound();
  const view = await watching(sound);
  expect(view.preview.audio?.(thread)).toBe(false);
  for (const viewport of view.viewport()) expect(viewport).not.toMatchObject({ audio: true });
  view.sound(1, 1_000);
  expect(sound.decoded).toEqual([]);
  expect(sound.opened()).toBe(0);
});

test("unmuting opens the speaker, asks the daemon for sound and plays it with the picture", async () => {
  const sound = fakeSound();
  const view = await watching(sound);
  // A picture captured at 1 000 on the daemon's clock shows at 50 150 here.
  view.clock.now = 50_150;
  view.picture(1, 1_000);
  view.preview.setAudio?.(thread, true);
  expect(sound.opened()).toBe(1);
  expect(view.preview.audio?.(thread)).toBe(true);
  await waitFor(() =>
    expect(view.wire.requests).toContainEqual(
      expect.objectContaining({
        type: "browser.capture",
        viewport: expect.objectContaining({ audio: true, width: 390 }),
      }),
    ),
  );
  // Sound captured with that picture arrives sooner, and waits to play when it shows.
  view.clock.now = 50_040;
  view.sound(1, 1_000);
  expect(sound.played).toEqual([{ timestamp: 1_000, at: 50_150 }]);
});

test("without pictures, sound plays a short buffer behind its arrival", async () => {
  const sound = fakeSound();
  const view = await watching(sound);
  view.preview.setAudio?.(thread, true);
  view.clock.now = 50_040;
  view.sound(1, 1_000);
  expect(sound.played).toEqual([{ timestamp: 1_000, at: 50_040 + bufferMs }]);
});

test("muting tells the daemon, closes the speaker and plays nothing more", async () => {
  const sound = fakeSound();
  const view = await watching(sound);
  view.preview.setAudio?.(thread, true);
  view.preview.setAudio?.(thread, false);
  expect(sound.closed()).toBe(1);
  await waitFor(() => expect(view.viewport().at(-1)).toMatchObject({ audio: false }));
  view.sound(1, 1_000);
  expect(sound.decoded).toEqual([]);
});

test("a client that can't decode sound offers no speaker", async () => {
  const view = await watching(null);
  expect(view.preview.audio?.(thread)).toBeUndefined();
});
