import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MediaOwner } from "@ace/media/media-connections";
import { MediaRuntime } from "@ace/media/runtime";
import { nodeMediaHost, systemMediaClock } from "@ace/media/supervisor";
import { fakeDelivery, phoneOwner } from "@ace/media/testing/fake-delivery";
import { MediaTestClient } from "@ace/media/testing/media-test-client";
import { connectBrowser } from "./index.ts";
import type { BrowserMedia } from "./media-video.ts";
import { decodeStreamMessage, StreamAssembler, streamKinds, type StreamMessage } from "./stream.ts";
import type { BrowserAudioChunk } from "./stream-audio.ts";
import { executablePath, fixture, ref } from "./test-support.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A built ace-media (`bun run check:media` builds it): what delivers a viewer's sound here. */
const binary = process.env.ACE_MEDIA_TEST_BINARY?.trim() || undefined;

const mediaCleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of mediaCleanups.splice(0).toReversed()) cleanup();
});

/** A real MediaRuntime on the binary, and the BrowserMedia the daemon gives the browser. */
function media() {
  const path = binary ?? "";
  const runtimeDir = mkdtempSync(join(tmpdir(), "acem-"));
  let ids = 0;
  const runtime = new MediaRuntime({
    version: execFileSync(path, ["--version"]).toString().trim(),
    binary: path,
    runtimeDir,
    dataDir: runtimeDir,
    host: nodeMediaHost(process.env),
    clock: systemMediaClock,
    random: Math.random,
    listen: () => ({ message: { type: "listen", loopback: true }, payload: new Uint8Array(0) }),
    id: () => `source-${++ids}`,
    platform: process.platform,
    log: () => {},
  });
  const browser: BrowserMedia = {
    add: (producer) => runtime.sources.add(producer),
    routed: (kind) => runtime.sources.routed(kind),
    wanted: (kind) => runtime.sources.wanted(kind),
    pictureCodecs: () => runtime.pictureCodecs(),
    endpoint: () => runtime.sources.endpoint(),
  };
  mediaCleanups.push(() => {
    runtime.dispose();
    rmSync(runtimeDir, { recursive: true, force: true });
  });
  runtime.reroute();
  return { runtime, browser };
}

/** The session a viewer's media connection belongs to. */
const mediaOwner: MediaOwner = {
  session: "main-1",
  device: "phone",
  admission: { kind: "pairing", generation: "3f9a1c0e7b2d4a6c8e1f0b2d4c6e8a1f" },
};

const viewport = (on: boolean) => ({
  width: 640,
  height: 400,
  devicePixelRatio: 2,
  ...(on ? { audio: true } : {}),
});

/** A phone-sized video viewer over a binary connection, its speaker on or off. */
function viewer(f: Fixture, connectionId: string, audio: boolean) {
  const streamed: StreamMessage[] = [];
  const assembler = new StreamAssembler();
  let audioBytes = 0;
  const bridge = connectBrowser(f.service, {
    connectionId,
    authorize: () => true,
    send: () => true,
    sendStream: (pieces) => {
      for (const piece of pieces) {
        // Every byte of every piece of the audio kind, whether or not it decodes.
        if (piece[5] === streamKinds.browserAudio) audioBytes += piece.length;
        const envelope = assembler.push(piece);
        const message = envelope && decodeStreamMessage(envelope);
        if (!message) continue;
        streamed.push(message);
        // Shown at once: the window stays open, as a viewer keeping up keeps it.
        if (message.kind === "browser.video")
          void bridge.handle({
            type: "browser.ack",
            threadId: "thread",
            requestId: `ack-${message.chunk.sequence}`,
            sequence: message.chunk.sequence,
            video: true,
          });
      }
      return true;
    },
  });
  return {
    bridge,
    audio: () =>
      streamed.flatMap((message) => (message.kind === "browser.audio" ? [message.chunk] : [])),
    video: () =>
      streamed.flatMap((message) => (message.kind === "browser.video" ? [message.chunk] : [])),
    audioBytes: () => audioBytes,
    subscribe: () =>
      bridge.handle({
        type: "browser.subscribe",
        threadId: "thread",
        requestId: "subscribe",
        binaryFrames: true,
        viewport: viewport(audio),
        video: { codecs: ["avc1.42E033", "vp8"] },
      }),
    speaker: (on: boolean) =>
      bridge.handle({
        type: "browser.capture",
        threadId: "thread",
        requestId: `speaker-${on}`,
        viewport: viewport(on),
      }),
  };
}

async function until(done: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the stream");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The tab the person is shown, as the session lists it. */
function shownTab(f: Fixture) {
  const state = f.service.state("thread");
  return state.tabs?.find((tab) => tab.tabId === state.activeTabId);
}

/**
 * A viewer whose view ace-media delivers, so its tab's capture starts and loads the extension.
 * With a media runtime it watches the real media connection and keeps every piece it receives;
 * without one the delivery is fake and only what the tab itself reports is exercised.
 */
function mediaViewer(
  f: Fixture,
  options: {
    connectionId?: string;
    /** The view's sound, as the app's speaker turns it on and off (ADR 0088, Audio). */
    audio?: boolean;
    runtime?: MediaRuntime;
  } = {},
) {
  const audio = options.audio ?? true;
  const delivery = fakeDelivery();
  const streamed: StreamMessage[] = [];
  const assembler = new StreamAssembler();
  let audioBytes = 0;
  let client: MediaTestClient | undefined;
  const bridge = connectBrowser(f.service, {
    connectionId: options.connectionId ?? "viewer",
    authorize: () => true,
    send: () => true,
    media: {
      owner: () => (options.runtime ? mediaOwner : phoneOwner),
      delivery: () => options.runtime?.delivery() ?? delivery.port,
    },
  });
  const collect = (pieces: readonly Uint8Array[]) => {
    for (const piece of pieces) {
      // Every byte of every piece of the audio kind, whether or not it decodes.
      if (piece[5] === streamKinds.browserAudio) audioBytes += piece.length;
      const envelope = assembler.push(piece);
      const message = envelope && decodeStreamMessage(envelope);
      if (!message) continue;
      streamed.push(message);
      // Shown at once: the window stays open, as a viewer keeping up keeps it.
      if (message.kind === "browser.video")
        client?.send({
          type: "browser.ack",
          threadId: "thread",
          sequence: message.chunk.sequence,
          video: true,
        });
    }
  };
  return {
    bridge,
    audio: () =>
      streamed.flatMap((message) => (message.kind === "browser.audio" ? [message.chunk] : [])),
    video: () =>
      streamed.flatMap((message) => (message.kind === "browser.video" ? [message.chunk] : [])),
    audioBytes: () => audioBytes,
    subscribe: async () => {
      let connection = "mc_aaaaaaaaaaaa";
      if (options.runtime) {
        const grant = await options.runtime.connections.connect(mediaOwner);
        if (!grant.ok) throw new Error(`media.connect: ${grant.code}`);
        client = await MediaTestClient.open(grant, {
          onPiece: (piece) => collect([piece]),
        });
        connection = grant.connection;
      }
      return bridge.handle({
        type: "browser.subscribe",
        threadId: "thread",
        requestId: "subscribe",
        subscriberId: "subscriber-1b4e28ba-2fa1-11d2-883f-0016d3cca427",
        binaryFrames: true,
        viewport: viewport(audio),
        video: { codecs: ["avc1.42E033", "vp8"] },
        media: { connection },
        ...(options.runtime ? { mediaClient: true } : {}),
      });
    },
    speaker: (on: boolean) =>
      bridge.handle({
        type: "browser.capture",
        threadId: "thread",
        requestId: `speaker-${on}`,
        viewport: viewport(on),
      }),
    close: () => {
      bridge.close();
      client?.close();
    },
  };
}

/** Decodes Opus chunks with WebCodecs in the page: the loudest sample and the tone's pitch. */
async function hear(f: Fixture, chunks: readonly BrowserAudioChunk[]) {
  const first = chunks[0];
  if (!first) throw new Error("No audio");
  const input = chunks.map((chunk) => Buffer.from(chunk.bytes).toString("base64"));
  const config = { codec: first.codec, sampleRate: first.sampleRate, channels: first.channels };
  const result = await f.evaluate(`(async () => {
    const config = ${JSON.stringify(config)};
    const samples = [];
    const errors = [];
    const decoder = new AudioDecoder({
      output: (data) => {
        const plane = new Float32Array(data.numberOfFrames);
        data.copyTo(plane, { planeIndex: 0, format: "f32-planar" });
        samples.push(...plane);
        data.close();
      },
      error: (error) => errors.push(String(error)),
    });
    decoder.configure({ codec: config.codec, sampleRate: config.sampleRate, numberOfChannels: config.channels });
    let timestamp = 0;
    for (const chunk of ${JSON.stringify(input)}) {
      decoder.decode(new EncodedAudioChunk({ type: "key", timestamp, data: Uint8Array.from(atob(chunk), (c) => c.charCodeAt(0)) }));
      timestamp += 20000;
    }
    await decoder.flush().catch((error) => errors.push(String(error)));
    // The steady middle: Opus starts with a short ramp.
    const steady = samples.slice(Math.floor(samples.length / 4));
    let peak = 0, crossings = 0;
    for (let i = 1; i < steady.length; i++) {
      peak = Math.max(peak, Math.abs(steady[i]));
      if ((steady[i - 1] < 0) !== (steady[i] < 0)) crossings++;
    }
    const seconds = steady.length / config.sampleRate;
    return JSON.stringify({ peak, pitch: crossings / 2 / seconds, errors, samples: samples.length });
  })()`);
  return JSON.parse(String(result)) as {
    peak: number;
    pitch: number;
    errors: string[];
    samples: number;
  };
}

/** A 440 Hz tone the page starts on a click (pages may only start sound after a gesture). */
const tone = `document.querySelector('button').addEventListener('click', () => {
  window.audioContext = new AudioContext();
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.frequency.value = 440;
  gain.gain.value = 0.5;
  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start();
});
window.animating = true; window.counter = 0;
(function animate() { if (!window.animating) return; document.body.style.background = 'rgb(' + (++window.counter % 255) + ',40,90)'; requestAnimationFrame(animate); })();`;

describe.skipIf(!executablePath)("page audio from ace's Chrome", () => {
  it.skipIf(!binary)(
    "an unmuted viewer hears the page's tone as Opus, in step with the video; a muted one gets no audio bytes",
    async () => {
      const m = media();
      const f = await fixture({ media: m.browser });
      await f.navigate();
      await f.evaluate(tone);
      await f.execute({ action: "click", ref: ref(await f.execute({ action: "snapshot" }), "Save") });
      await until(async () => (await f.evaluate("window.audioContext?.state")) === "running");
      const listener = mediaViewer(f, {
        connectionId: "listener",
        audio: true,
        runtime: m.runtime,
      });
      const muted = mediaViewer(f, { connectionId: "muted", audio: false, runtime: m.runtime });
      await listener.subscribe();
      await muted.subscribe();
      // A second of sound: fifty 20 ms Opus packets.
      await until(() => listener.audio().length >= 50);
      const chunks = listener.audio();
      // Opus always codes at 48 kHz, whatever rate the tab is captured at (the output device's on
      // a Mac, the sound server's mix rate on Linux), so every chunk says 48 kHz. The pitch check
      // below decodes at that rate, and its band is narrow enough that a wrong one (440 Hz heard
      // as 404 or 479) fails it.
      expect(chunks[0]).toMatchObject({ codec: "opus", sampleRate: 48_000 });
      const heard = await hear(f, chunks);
      expect(heard.errors).toEqual([]);
      expect(heard.peak).toBeGreaterThan(0.1);
      expect(heard.pitch).toBeGreaterThan(425);
      expect(heard.pitch).toBeLessThan(455);
      // Stamped on the video's clock: the newest sound and the newest picture are moments apart.
      await until(() => listener.video().length > 0);
      const lastVideo = listener.video().at(-1)?.timestamp ?? 0;
      const nearest = Math.min(
        ...listener.audio().map((chunk) => Math.abs(chunk.timestamp - lastVideo)),
      );
      expect(nearest).toBeLessThan(250);
      // The other viewer plays the same video, muted: not one audio byte.
      expect(muted.video().length).toBeGreaterThan(0);
      expect(muted.audio()).toEqual([]);
      expect(muted.audioBytes()).toBe(0);

      // Once the listener mutes too, nobody listens and the sound stops.
      await listener.speaker(false);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const after = listener.audio().length;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(listener.audio().length).toBe(after);
      await f.evaluate("window.animating = false");
      listener.close();
      muted.close();
    },
    90_000,
  );

  // The address bar's speaker shows only for a tab that reports it plays sound (ADR 0088,
  // Audio); a headless tab's sound otherwise reaches no viewer.
  it("a headless tab that plays sound lists as audible, and muting it lists it as muted", async () => {
    const f = await fixture();
    await f.navigate();
    await f.evaluate(tone);
    // A viewer with its sound on starts the capture that carries the page's sound.
    const listener = mediaViewer(f);
    await listener.subscribe();
    await f.execute({ action: "click", ref: ref(await f.execute({ action: "snapshot" }), "Save") });
    await until(async () => (await f.evaluate("window.audioContext?.state")) === "running");
    await until(() => shownTab(f)?.audible === true);
    const tab = shownTab(f);
    if (!tab) throw new Error("No shown tab");
    await f.service.asPerson("thread", { kind: "mute", tabId: tab.tabId, muted: true });
    await until(() => shownTab(f)?.muted === true);
    await f.evaluate("window.animating = false");
    listener.close();
  }, 60_000);

  // A page already playing sound before anyone watched it sends no change once the extension
  // loads, so the tab has to seed what it hears.
  it("a headless tab already playing sound when its view opens lists as audible", async () => {
    const f = await fixture();
    await f.navigate();
    await f.evaluate(tone);
    // Sound first: no viewer, so the extension isn't loaded and hears no change.
    await f.execute({ action: "click", ref: ref(await f.execute({ action: "snapshot" }), "Save") });
    await until(async () => (await f.evaluate("window.audioContext?.state")) === "running");
    const listener = mediaViewer(f);
    await listener.subscribe();
    await until(() => shownTab(f)?.audible === true);
    await f.evaluate("window.animating = false");
    listener.close();
  }, 60_000);
});

// Windows captures a tab at the audio engine's mix rate (48 kHz with ace's fake output device)
// while the page's AudioContext may run at 44.1 kHz, so the rate is checked by ear: decoded at
// the reported rate, the tone must still be 440 Hz.
it.runIf(process.platform === "win32" && executablePath)(
  "Windows: an unmuted viewer hears the page's 440 Hz tone at the capture's reported rate; a muted one gets no audio bytes",
  async () => {
    const f = await fixture();
    await f.navigate();
    await f.evaluate(tone);
    await f.execute({ action: "click", ref: ref(await f.execute({ action: "snapshot" }), "Save") });
    await until(async () => (await f.evaluate("window.audioContext?.state")) === "running");
    const listener = viewer(f, "listener", true);
    const muted = viewer(f, "muted", false);
    await listener.subscribe();
    await muted.subscribe();
    await until(() => listener.audio().length >= 50);
    const chunks = listener.audio();
    expect(chunks[0]?.codec).toBe("opus");
    expect([44_100, 48_000]).toContain(chunks[0]?.sampleRate);
    const heard = await hear(f, chunks);
    expect(heard.errors).toEqual([]);
    expect(heard.peak).toBeGreaterThan(0.1);
    expect(heard.pitch).toBeGreaterThan(400);
    expect(heard.pitch).toBeLessThan(480);
    // Stamped on the video's clock: the newest sound and the newest picture are moments apart.
    await until(() => listener.video().length > 0);
    const lastVideo = listener.video().at(-1)?.timestamp ?? 0;
    const nearest = Math.min(
      ...listener.audio().map((chunk) => Math.abs(chunk.timestamp - lastVideo)),
    );
    expect(nearest).toBeLessThan(250);
    expect(muted.video().length).toBeGreaterThan(0);
    expect(muted.audio()).toEqual([]);
    expect(muted.audioBytes()).toBe(0);
    await listener.speaker(false);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const after = listener.audio().length;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(listener.audio().length).toBe(after);
    await f.evaluate("window.animating = false");
    listener.bridge.close();
    muted.bridge.close();
  },
  90_000,
);
