import { afterEach, expect, it } from "vitest";
import type { BrowserVideoChunk } from "@ace/browser/stream";
import { startVideoSession, threadId, watchVideo } from "./fixtures/video-session.ts";

/**
 * What a remote viewer of a desktop view decodes (ADR 0088, embedded backend): the chunks the
 * app's encoder sends, decoded with WebCodecs the way the web client configures its decoder
 * (codec, the chunk's coded size, the keyframe's avcC). The tab's height is not a multiple of
 * 16, so an encoder that pads its coded size shows here. The agent repaints the page while the
 * viewer watches. Opt in with ACE_E2E_ELECTRON=1 (`bun run desktop:e2e`).
 */
const enabled = process.env.ACE_E2E_ELECTRON === "1";
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const width = 1280;
const height = 750;
const red = `<!doctype html><body style="margin:0;background:rgb(220,20,20)"></body>`;

interface Wire {
  codec: string;
  key: boolean;
  codedWidth: number;
  codedHeight: number;
  description: string | undefined;
  bytes: string;
}

interface Decoded {
  displayWidth: number;
  displayHeight: number;
  /** The decoded picture's centre pixel, as `[r, g, b]`. */
  centre: number[];
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/**
 * Runs in the decoder page: decodes the chunks in order from the first keyframe, reconfiguring
 * at every keyframe as the web client does, and reports each picture's size and centre colour.
 */
async function decodeAll(chunks: Wire[]): Promise<{ pictures: Decoded[]; errors: string[] }> {
  // Inside: this function runs in the page, with nothing from this module.
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const bytes = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  const pictures: Decoded[] = [];
  const errors: string[] = [];
  const canvas = new OffscreenCanvas(1, 1);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("No 2D context");
  const decoder = new VideoDecoder({
    output: (frame) => {
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
      context.drawImage(frame, 0, 0);
      const pixel = context.getImageData(frame.displayWidth / 2, frame.displayHeight / 2, 1, 1);
      pictures.push({
        displayWidth: frame.displayWidth,
        displayHeight: frame.displayHeight,
        centre: Array.from(pixel.data.subarray(0, 3)),
      });
      frame.close();
    },
    error: (error) => errors.push(`${error.name}: ${error.message}`),
  });
  let timestamp = 0;
  const start = chunks.findIndex((chunk) => chunk.key);
  for (const chunk of start < 0 ? [] : chunks.slice(start)) {
    if (decoder.state === "closed") break;
    if (chunk.key)
      decoder.configure({
        codec: chunk.codec,
        codedWidth: chunk.codedWidth,
        codedHeight: chunk.codedHeight,
        optimizeForLatency: true,
        ...(chunk.description ? { description: bytes(chunk.description) } : {}),
      });
    decoder.decode(
      new EncodedVideoChunk({
        type: chunk.key ? "key" : "delta",
        timestamp: (timestamp += 16_667),
        data: bytes(chunk.bytes),
      }),
    );
  }
  if (decoder.state === "configured") await decoder.flush();
  return { pictures, errors };
}

const isRed = ([r = 0, g = 0, b = 0]: number[]) => r > 150 && g < 80 && b < 80;
const isBlue = ([r = 0, g = 0, b = 0]: number[]) => b > 150 && r < 80 && g < 80;

it.runIf(enabled)(
  "a remote viewer decodes a desktop view at the tab's own size and sees the agent repaint it",
  async () => {
    const { app, service, origin } = await startVideoSession(cleanups, {
      "/": red,
      "/decoder": "<!doctype html><title>decoder</title>",
    });
    await service.execute(threadId, { action: "navigate", url: `${origin}/` });
    await service.execute(threadId, { action: "resize", width, height });

    const chunks: BrowserVideoChunk[] = [];
    await watchVideo(cleanups, service, {
      viewport: { width, height },
      codecs: ["avc1.640033", "avc1.42E033"],
      onChunk: (chunk) => chunks.push(chunk),
    });
    await expect.poll(() => chunks.some((chunk) => chunk.key), { timeout: 20_000 }).toBe(true);
    // The page shows the first picture for a while, then the agent repaints it.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await service.execute(threadId, {
      action: "evaluate",
      expression: `document.body.style.background = "rgb(20,20,220)"`,
      mode: "unrestricted",
    });
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    // Decoded in the app's own Chromium, in a secure context (the loopback test server).
    const page = await app.firstWindow();
    await page.goto(`${origin}/decoder`);
    const received = [...chunks];
    const { pictures, errors } = await page.evaluate(
      decodeAll,
      received.map((chunk) => ({
        codec: chunk.codec,
        key: chunk.key,
        codedWidth: chunk.codedWidth,
        codedHeight: chunk.codedHeight,
        description: chunk.description && base64(chunk.description),
        bytes: base64(chunk.bytes),
      })),
    );
    const keyframes = received.filter((chunk) => chunk.key).length;
    console.log(
      JSON.stringify({
        chunks: received.length,
        keyframes,
        codecs: [...new Set(received.map((chunk) => chunk.codec))],
        reported: [...new Set(received.map((chunk) => `${chunk.codedWidth}x${chunk.codedHeight}`))],
        decoded: [...new Set(pictures.map((p) => `${p.displayWidth}x${p.displayHeight}`))],
        pictures: pictures.length,
        errors,
      }),
    );

    expect(errors).toEqual([]);
    expect(keyframes).toBeGreaterThan(0);
    // Every chunk after the first keyframe decodes to a picture.
    const first = received.findIndex((chunk) => chunk.key);
    expect(pictures.length).toBe(received.length - first);
    // The picture is the tab's own size, as the stream reports it: no padding rows.
    for (const chunk of received)
      expect([chunk.codedWidth, chunk.codedHeight]).toEqual([width, height]);
    for (const picture of pictures)
      expect([picture.displayWidth, picture.displayHeight]).toEqual([width, height]);
    // The page as it was, then as the agent repainted it.
    const firstBlue = pictures.findIndex((picture) => isBlue(picture.centre));
    expect(firstBlue).toBeGreaterThan(0);
    expect(pictures.slice(0, firstBlue).some((picture) => isRed(picture.centre))).toBe(true);
    expect(pictures.at(-1)?.centre).toSatisfy(isBlue);
  },
);
