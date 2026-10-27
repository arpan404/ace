import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { BrowserService, connectBrowser, detectChromium } from "../src/index.ts";
import { decodeStreamMessage, StreamAssembler } from "../src/stream.ts";
import type { BrowserVideoChunk } from "../src/stream-video.ts";

/*
 * Frame rate against sharpness for each device scale ace's Chrome could draw at, report only.
 * For every scale: frames delivered per second for a continuously scrolling 1280 × 800 page
 * watched at DPR 2 (viewer acks at once), and how sharp a Retina viewer's still picture is
 * against a screenshot of the page (luma PSNR), at an odd and an even pane size, before and
 * after a scroll. Used to choose ace's Windows software-rendering scale (`gpu-scale.ts`).
 */

const executable = process.env.ACE_CHROMIUM_PATH ?? (await detectChromium());
if (!executable) {
  console.log(JSON.stringify({ skipped: "no Chrome or Chromium installed" }));
  process.exit(0);
}
const scales = (process.env.ACE_TRADEOFF_SCALES ?? "1,1.25,1.5,2").split(",").map(Number);
const codecs = ["hvc1.1.6.L153.B0", "avc1.640033", "avc1.42E033", "vp09.00.41.08", "vp8"];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const scroll = Array.from(
  { length: 600 },
  (_, index) => `<p>${index}. Remote browser view: sharp text and smooth scrolling 0123456789.</p>`,
).join("");
const prose = Array.from(
  { length: 60 },
  (_, line) => `<p>Line ${line}: the quick brown fox jumps over the lazy dog 0123456789.</p>`,
).join("");
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end(
    request.url === "/scroll"
      ? `<!doctype html><body style="margin:24px;font:16px/1.5 system-ui">${scroll}<script>let y=0;(function s(){y=(y+4)%30000;scrollTo(0,y);requestAnimationFrame(s)})()</script>`
      : `<!doctype html><body style="font: 13px sans-serif">${prose}</body>`,
  );
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Missing server address");
const origin = `http://127.0.0.1:${address.port}`;

function viewer(service: BrowserService, viewport: { width: number; height: number }) {
  const chunks: BrowserVideoChunk[] = [];
  const shown: number[] = [];
  const assembler = new StreamAssembler();
  const bridge = connectBrowser(service, {
    connectionId: "tradeoff",
    local: true,
    authorize: () => true,
    send: () => true,
    sendStream: (pieces) => {
      for (const piece of pieces) {
        const envelope = assembler.push(piece);
        const message = envelope && decodeStreamMessage(envelope);
        if (message?.kind !== "browser.video") continue;
        chunks.push(message.chunk);
        shown.push(performance.now());
        void bridge.handle({
          type: "browser.ack",
          threadId: "t",
          requestId: "ack",
          sequence: message.chunk.sequence,
          video: true,
        });
      }
      return true;
    },
  });
  const subscribed = bridge.handle({
    type: "browser.subscribe",
    threadId: "t",
    requestId: "subscribe",
    binaryFrames: true,
    viewport: { ...viewport, devicePixelRatio: 2 },
    video: { codecs },
  });
  return { bridge, chunks, shown, subscribed };
}

async function put(service: BrowserService, name: string, value: string) {
  const run = (expression: string) => service.execute("t", { action: "evaluate", expression });
  await run(`window.${name} = ""; 1`);
  for (let index = 0; index < value.length; index += 60_000)
    await run(`window.${name} += ${JSON.stringify(value.slice(index, index + 60_000))}; 1`);
}

/** PSNR (dB) of the picture shown now against a screenshot, and the picture's size. */
async function sharpness(service: BrowserService, chunks: readonly BrowserVideoChunk[]) {
  let start = 0;
  chunks.forEach((chunk, index) => {
    if (chunk.key) start = index;
  });
  const shown = chunks.slice(start);
  const first = shown[0];
  if (!first?.key) throw new Error("No keyframe");
  const shot = z
    .object({ path: z.string() })
    .parse(await service.execute("t", { action: "screenshot" }));
  await put(service, "__png", (await readFile(shot.path)).toString("base64"));
  await put(
    service,
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
  const result = await service.execute("t", {
    action: "evaluate",
    expression: `(async () => {
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
      return JSON.stringify({ width: last.visibleRect.width, height: last.visibleRect.height, codec: config.codec, psnr: 10 * Math.log10(255 * 255 / (error / a.length)) });
    })()`,
  });
  return JSON.parse(String(result)) as {
    width: number;
    height: number;
    codec: string;
    psnr: number;
  };
}

async function measure(scale: number) {
  const home = await mkdtemp(join(tmpdir(), "ace-tradeoff-"));
  const service = new BrowserService({
    dataDir: home,
    executablePath: executable as string,
    chrome: { deviceScaleFactor: scale },
  });
  try {
    await service.open({ threadId: "t", workspaceId: "w" });
    // Frame rate: a page that scrolls every frame.
    await service.execute("t", { action: "navigate", url: `${origin}/scroll` });
    await service.execute("t", { action: "resize", width: 1280, height: 800 });
    const moving = viewer(service, { width: 1280, height: 800 });
    await moving.subscribed;
    await sleep(4_000);
    const from = performance.now();
    await sleep(8_000);
    const fps = moving.shown.filter((at) => at >= from).length / 8;
    moving.bridge.close();
    // Sharpness: still prose at an odd and an even pane, then after a scroll.
    const sharp: Record<string, unknown> = {};
    for (const [width, height] of [
      [659, 825],
      [660, 826],
    ] as const) {
      await service.execute("t", { action: "navigate", url: `${origin}/prose` });
      await service.execute("t", { action: "resize", width, height });
      const still = viewer(service, { width, height });
      await still.subscribed;
      for (let tries = 0; tries < 100 && !still.chunks.length; tries++) {
        await service.execute("t", {
          action: "evaluate",
          expression: `document.body.style.background = document.body.style.background ? "" : "#fff"; 1`,
        });
        await sleep(200);
      }
      await sleep(2_000);
      const before = await sharpness(service, still.chunks);
      await service.execute("t", { action: "scroll", x: 0, y: 400 });
      await sleep(2_000);
      const after = await sharpness(service, still.chunks);
      sharp[`${width}x${height}`] = {
        picture: `${before.width}x${before.height}`,
        codec: before.codec,
        still: Math.round(before.psnr * 10) / 10,
        afterScroll: Math.round(after.psnr * 10) / 10,
      };
      still.bridge.close();
    }
    return { scale, fps: Math.round(fps * 10) / 10, sharp };
  } finally {
    await service.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(
      () => {},
    );
  }
}

try {
  for (const scale of scales)
    console.log(
      JSON.stringify(
        await measure(scale).catch((error: unknown) => ({ scale, error: String(error) })),
      ),
    );
} finally {
  server.closeAllConnections();
  server.close();
}
