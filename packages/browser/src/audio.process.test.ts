import { describe, expect, it } from "vitest";
import { connectBrowser } from "./index.ts";
import { decodeStreamMessage, StreamAssembler, streamKinds, type StreamMessage } from "./stream.ts";
import type { BrowserAudioChunk } from "./stream-audio.ts";
import { executablePath, fixture, ref } from "./test-support.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;

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
  it("an unmuted viewer hears the page's tone as Opus, in step with the video; a muted one gets no audio bytes", async () => {
    const f = await fixture();
    await f.navigate();
    await f.evaluate(tone);
    await f.execute({ action: "click", ref: ref(await f.execute({ action: "snapshot" }), "Save") });
    await until(async () => (await f.evaluate("window.audioContext?.state")) === "running");
    const listener = viewer(f, "listener", true);
    const muted = viewer(f, "muted", false);
    await listener.subscribe();
    await muted.subscribe();
    // A second of sound: fifty 20 ms Opus packets.
    await until(() => listener.audio().length >= 50);
    const chunks = listener.audio();
    // Chrome captures the tab at the output device's rate (48 kHz speakers, 44.1 kHz Bluetooth
    // headphones), the rate the page's own AudioContext runs at. The pitch check below
    // decodes at the reported rate, so a wrong rate would also mishear the tone.
    const pageRate = Number(await f.evaluate("audioContext.sampleRate"));
    expect(chunks[0]).toMatchObject({ codec: "opus", sampleRate: pageRate });
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
    listener.bridge.close();
    muted.bridge.close();
  }, 90_000);
});
