/*
 * A still JPEG-only screen's live view, against the real ace-media (X2, X3): the helper is
 * change-driven, so a screen that doesn't change sends one picture when its stream is configured
 * and nothing after. A view must start from a picture whether it subscribes first or again with
 * what it had (the web live view skips a `stream.configure` that changes nothing, so the helper
 * makes no new picture). What a unit test can't show: ace-media's encoder, its delivery on a
 * client's media connection and its keyframe requests, meeting on one still picture. Runs when
 * ACE_MEDIA_TEST_BINARY names a built ace-media.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { decodeStreamMessage, StreamAssembler } from "@ace/browser/stream";
import type { MediaOwner } from "@ace/media/media-connections";
import { MediaRuntime } from "@ace/media/runtime";
import { nodeMediaHost, systemMediaClock } from "@ace/media/supervisor";
import { MediaTestClient } from "@ace/media/testing/media-test-client";
import { FrameDecoder, framePacket, type Frame } from "./frames.ts";
import { ScreenPictureSource } from "./picture-source.ts";

const binary = process.env.ACE_MEDIA_TEST_BINARY?.trim() || undefined;
const jpeg = readFileSync(new URL("./testing/phone-screen.jpg", import.meta.url));

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup();
});

async function until(condition: () => boolean, ms = 10_000): Promise<void> {
  const end = performance.now() + ms;
  while (!condition()) {
    if (performance.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The helper's still: a real 390×844 phone screen. */
function still(sequence: number): Frame {
  const frames: Frame[] = [];
  new FrameDecoder((frame) => void frames.push(frame)).push(
    framePacket(
      {
        version: 2,
        sessionId: "s1",
        seq: sequence,
        ts: sequence,
        width: 390,
        height: 844,
        scale: 1,
        codec: "jpeg",
        bytes: jpeg.length,
      },
      jpeg,
    ),
  );
  const [frame] = frames;
  if (!frame) throw new Error("no frame");
  return frame;
}

const owner: MediaOwner = {
  session: "main-1",
  device: "phone",
  admission: { kind: "pairing", generation: "3f9a1c0e7b2d4a6c8e1f0b2d4c6e8a1f" },
};

/** ace-media, a still screen streaming into it, and how many pictures its helper made. */
function stillScreen() {
  if (!binary) throw new Error("no ace-media binary");
  const runtimeDir = mkdtempSync(join(tmpdir(), "acem-still-"));
  let ids = 0;
  const runtime = new MediaRuntime({
    version: execFileSync(binary, ["--version"]).toString().trim(),
    binary,
    runtimeDir,
    dataDir: runtimeDir,
    host: nodeMediaHost(process.env),
    clock: systemMediaClock,
    random: Math.random,
    listen: () => ({ message: { type: "listen", loopback: true }, payload: new Uint8Array(0) }),
    id: () => `id-${++ids}`,
    platform: process.platform,
    capabilities: { ingest: ["screen-pictures"], delivery: true },
    log: () => {},
  });
  let sequence = 0;
  const helper = {
    made: 0,
    capabilities: undefined,
    permissions: async () => ({ screenRecording: true, accessibility: true }),
    requestV2: async () => ({}),
    request: async (request: { op: string }) => {
      // As the real helper does (markInitial): a configured stream starts over with the screen
      // as it is. Nothing changes on screen, so that is its only picture.
      if (request.op === "stream.configure")
        setImmediate(() => {
          helper.made++;
          source.daemonFrame(still(++sequence));
        });
      return { codec: "jpeg" };
    },
  };
  const source: ScreenPictureSource = new ScreenPictureSource({
    sessionId: "s1",
    platform: process.platform,
    helper,
    media: { add: (producer) => runtime.sources.add(producer) },
    accept: () => {},
    now: () => performance.now(),
  });
  cleanups.push(() => {
    source.close();
    runtime.dispose();
    rmSync(runtimeDir, { recursive: true, force: true });
  });
  return { runtime, source, helper };
}

/** A client's media connection, the screen keyframes it gets, and a subscribe on it. */
async function viewer(runtime: MediaRuntime) {
  const grant = await runtime.connections.connect(owner);
  if (!grant.ok) throw new Error(`media.connect: ${grant.code}`);
  const keys: number[] = [];
  const assembler = new StreamAssembler();
  let client: MediaTestClient | undefined;
  client = await MediaTestClient.open(grant, {
    onPiece: (piece) => {
      const envelope = assembler.push(piece);
      const message = envelope && decodeStreamMessage(envelope);
      if (message?.kind !== "screen.frame") return;
      if (message.frame.key) keys.push(message.frame.sequence);
      // Acked as a client acks what it shows.
      client?.send({
        type: "screen.ack",
        sessionId: message.sourceId,
        streamId: message.frame.streamId,
        sequence: message.frame.sequence,
      });
    },
  });
  const opened = client;
  cleanups.push(() => opened.close());
  return {
    keys,
    subscribe: () =>
      runtime.viewers.bind({
        requester: owner,
        connection: grant.connection,
        target: { kind: "screen", sessionId: "s1" },
        codecs: ["avc1.42E033"],
        viewport: { width: 390, height: 844, dpr: 1, scale: 1 },
        local: true,
        audio: false,
        shows: (producer) => producer.sessionId === "s1",
      }),
  };
}

it.skipIf(!binary)(
  "a still screen's view starts from a picture on a fresh subscribe, and again when its viewer subscribes again with what it had",
  async () => {
    const { runtime, source, helper } = stillScreen();
    await until(() => source.ingesting);
    const view = await viewer(runtime);
    expect(view.subscribe()).toBeDefined();
    await until(() => view.keys.length > 0, 15_000);
    // The view comes back with the settings it had: no new plan, so no new configure, and the
    // still screen makes no new picture. It starts from one anyway.
    const made = helper.made;
    const before = view.keys.length;
    expect(view.subscribe()).toBeDefined();
    await until(() => view.keys.length > before, 5_000);
    expect(helper.made).toBe(made);
  },
  60_000,
);
