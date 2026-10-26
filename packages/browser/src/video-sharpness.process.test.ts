import { readFile } from "node:fs/promises";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { connectBrowser } from "./index.ts";
import { decodeStreamMessage, StreamAssembler } from "./stream.ts";
import type { BrowserVideoChunk } from "./stream-video.ts";
import { executablePath, fixture } from "./test-support.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** The codecs ace's web client asks for, best first. */
const codecs = ["hvc1.1.6.L153.B0", "avc1.640033", "avc1.42E033", "vp09.00.41.08", "vp8"];
const prose = Array.from(
  { length: 60 },
  (_, line) => `<p>Line ${line}: the quick brown fox jumps over the lazy dog 0123456789.</p>`,
).join("");
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** A viewer on this machine that shows (acks) every chunk at once, as the desktop app does. */
async function localViewer(f: Fixture) {
  const chunks: BrowserVideoChunk[] = [];
  const assembler = new StreamAssembler();
  const bridge = connectBrowser(f.service, {
    connectionId: "desktop",
    local: true,
    authorize: () => true,
    send: () => true,
    sendStream: (pieces) => {
      for (const piece of pieces) {
        const envelope = assembler.push(piece);
        const message = envelope && decodeStreamMessage(envelope);
        if (message?.kind !== "browser.video") continue;
        chunks.push(message.chunk);
        const { sequence } = message.chunk;
        setTimeout(() => {
          void bridge.handle({
            type: "browser.ack",
            threadId: "thread",
            requestId: `ack-${sequence}`,
            sequence,
            video: true,
          });
        }, 2);
      }
      return true;
    },
  });
  await bridge.handle({
    type: "browser.subscribe",
    threadId: "thread",
    requestId: "subscribe",
    binaryFrames: true,
    viewport: { width: 659, height: 825, devicePixelRatio: 2 },
    video: { codecs },
  });
  return { bridge, chunks };
}

/** Sets `window[name]` to a long string, in pieces small enough for `evaluate`. */
async function put(f: Fixture, name: string, value: string) {
  await f.evaluate(`window.${name} = ""; 1`);
  for (let index = 0; index < value.length; index += 60_000)
    await f.evaluate(`window.${name} += ${JSON.stringify(value.slice(index, index + 60_000))}; 1`);
}

/**
 * Windows: Chrome there encodes VP9, and its software VP9 decoder pads a frame's coded width
 * to its buffer alignment (1318 becomes 1408). The visible picture is the full encode, so the
 * size check reads that instead.
 */
const visibleSizeOnWindows =
  process.platform === "win32"
    ? "last = { codedWidth: last.visibleRect.width, codedHeight: last.visibleRect.height };"
    : "";

/**
 * Decodes the stream from its last keyframe and compares the picture on screen now with a
 * screenshot of the page, at the screenshot's size: PSNR of luma, in dB.
 */
async function shownVersusPage(f: Fixture, chunks: readonly BrowserVideoChunk[]) {
  let start = 0;
  chunks.forEach((chunk, index) => {
    if (chunk.key) start = index;
  });
  const shown = chunks.slice(start);
  const first = shown[0];
  if (!first?.key) throw new Error("No keyframe");
  const shot = z.object({ path: z.string() }).parse(await f.execute({ action: "screenshot" }));
  await put(f, "__png", (await readFile(shot.path)).toString("base64"));
  await put(
    f,
    "__chunks",
    JSON.stringify(
      shown.map((chunk) => ({
        key: chunk.key,
        sequence: chunk.sequence,
        data: Buffer.from(chunk.bytes).toString("base64"),
      })),
    ),
  );
  const config = {
    codec: first.codec,
    codedWidth: first.codedWidth,
    codedHeight: first.codedHeight,
    ...(first.description
      ? { description: Buffer.from(first.description).toString("base64") }
      : {}),
  };
  const result = await f.evaluate(`(async () => {
    const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const config = ${JSON.stringify(config)};
    let last;
    const decoder = new VideoDecoder({ output: (frame) => { last?.close(); last = frame; }, error: () => {} });
    decoder.configure({ ...config, ...(config.description ? { description: bytes(config.description) } : {}) });
    for (const chunk of JSON.parse(window.__chunks))
      decoder.decode(new EncodedVideoChunk({ type: chunk.key ? "key" : "delta", timestamp: chunk.sequence, data: bytes(chunk.data) }));
    await decoder.flush();
    const page = await createImageBitmap(new Blob([bytes(window.__png)], { type: "image/png" }));
    const w = page.width, h = page.height;
    const luma = (source) => {
      const context = new OffscreenCanvas(w, h).getContext("2d");
      context.imageSmoothingQuality = "high";
      context.drawImage(source, 0, 0, w, h);
      const data = context.getImageData(0, 0, w, h).data;
      const out = new Float32Array(w * h);
      for (let i = 0; i < out.length; i++) out[i] = 0.299 * data[4*i] + 0.587 * data[4*i+1] + 0.114 * data[4*i+2];
      return out;
    };
    const a = luma(last), b = luma(page);
    let error = 0;
    for (let i = 0; i < a.length; i++) error += (a[i] - b[i]) ** 2;
    ${visibleSizeOnWindows}
    return JSON.stringify({ width: last.codedWidth, height: last.codedHeight, psnr: 10 * Math.log10(255 * 255 / (error / a.length)) });
  })()`);
  return z
    .object({ width: z.number(), height: z.number(), psnr: z.number() })
    .parse(JSON.parse(String(result)));
}

describe.skipIf(!executablePath)("how sharp the live video is", () => {
  it("a Retina viewer on this machine sees a still page, after a scroll too, as sharp as the page", async () => {
    const f = await fixture();
    await f.navigate();
    await f.execute({ action: "resize", width: 659, height: 825 });
    await f.evaluate(
      `document.body.style.cssText = "font: 13px sans-serif"; document.body.innerHTML = ${JSON.stringify(prose)}; 1`,
    );
    const viewer = await localViewer(f);
    // A page that has drawn already sends nothing new: nudge it until the first picture.
    for (let tries = 0; tries < 100 && !viewer.chunks.length; tries++) {
      await f.evaluate(
        `document.body.style.background = document.body.style.background ? "" : "#fff"; 1`,
      );
      await sleep(200);
    }
    await sleep(2_000);
    const joined = await shownVersusPage(f, viewer.chunks);
    // Full device pixels, not a smaller picture scaled up.
    expect([joined.width, joined.height]).toEqual([1318, 1650]);
    expect(joined.psnr).toBeGreaterThan(34);
    await f.execute({ action: "scroll", x: 0, y: 400 });
    await sleep(2_000);
    // Windows runners have no H.264 or HEVC encoder, so the stream is VP9 at a variable bit
    // rate: no sharp still keyframe (that needs per-frame quantizers), so after a scroll it
    // sharpens back to the still page's level instead of beyond it.
    if (process.platform === "win32" && viewer.chunks.at(-1)?.codec.startsWith("vp09")) {
      expect((await shownVersusPage(f, viewer.chunks)).psnr).toBeGreaterThan(joined.psnr - 0.5);
      viewer.bridge.close();
      return;
    }
    // Motion is coded coarse; once the page is still it sharpens again (about 35 dB without
    // the still page's sharp keyframe, about 38.5 with it).
    expect((await shownVersusPage(f, viewer.chunks)).psnr).toBeGreaterThan(37);
    viewer.bridge.close();
  }, 120_000);
});

// Windows draws ace's Chrome at device scale 1 where it has no GPU (`gpu-scale.ts`): the
// picture is the page's own device pixels at that scale, held to the same sharpness bars.
it.runIf(process.platform === "win32" && executablePath)(
  "Windows: a Retina viewer sees a still page, after a scroll too, as sharp as the page at the scale ace's Chrome draws",
  async () => {
    const f = await fixture();
    await f.navigate();
    await f.execute({ action: "resize", width: 659, height: 825 });
    await f.evaluate(
      `document.body.style.cssText = "font: 13px sans-serif"; document.body.innerHTML = ${JSON.stringify(prose)}; 1`,
    );
    const scale = Number(await f.evaluate("devicePixelRatio"));
    const viewer = await localViewer(f);
    for (let tries = 0; tries < 100 && !viewer.chunks.length; tries++) {
      await f.evaluate(
        `document.body.style.background = document.body.style.background ? "" : "#fff"; 1`,
      );
      await sleep(200);
    }
    await sleep(2_000);
    const joined = await shownVersusPage(f, viewer.chunks);
    expect([joined.width, joined.height]).toEqual([659 * scale, 825 * scale].map(Math.round));
    expect(joined.psnr).toBeGreaterThan(34);
    await f.execute({ action: "scroll", x: 0, y: 400 });
    await sleep(2_000);
    const after = (await shownVersusPage(f, viewer.chunks)).psnr;
    // VP9 at a variable rate has no sharp still keyframe: it returns to the still page's level.
    if (viewer.chunks.at(-1)?.codec.startsWith("vp09"))
      expect(after).toBeGreaterThan(joined.psnr - 0.5);
    else expect(after).toBeGreaterThan(37);
    viewer.bridge.close();
  },
  120_000,
);
