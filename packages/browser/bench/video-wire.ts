import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserService, connectBrowser, detectChromium } from "../src/index.ts";
import { decodeStreamMessage, StreamAssembler } from "../src/stream.ts";

/*
 * Bytes on the wire for a 60 s scroll session, video (ADR 0088) against binary JPEG frames, in
 * real headless Chrome. Two remote viewers of the same thread watch the same scrolling page: one
 * takes JPEG, one video, each acking 30 ms after a frame arrives (a good link). Part of
 * `check:perf`: it fails when video costs more than 40 % of JPEG's bytes (#1053), or plays fewer
 * frames per second than JPEG's calm remote rate (15). The 24 fps target of #1053 is reported,
 * not enforced: a loaded machine slows both encoders. Skipped where no Chrome is installed.
 *
 * ACE_VIDEO_BENCH_SECONDS shortens the session for a quick local run.
 */

const seconds = Number(process.env.ACE_VIDEO_BENCH_SECONDS ?? 60);
const ackDelayMs = 30;
const pane = { width: 1280, height: 800, devicePixelRatio: 2 };
const executablePath = await detectChromium();
if (!executablePath) {
  console.log(JSON.stringify({ path: "video wire", skipped: "no Chrome or Chromium installed" }));
  process.exit(0);
}

const paragraphs = Array.from(
  { length: 600 },
  (_, index) =>
    `<p>${index}. Remote browser view: sharp text and smooth scrolling over the encrypted socket. The quick brown fox jumps over the lazy dog, 0123456789.</p>`,
).join("");
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end(`<!doctype html><title>Scroll</title>
    <body style="margin:24px;font:16px/1.5 system-ui;color:#1d1d1f;background:#fff">${paragraphs}
    <script>let y = 0; setInterval(() => { y = (y + 6) % 30000; scrollTo(0, y); }, 16);</script>`);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Missing server address");
const home = await mkdtemp(join(tmpdir(), "ace-video-wire-"));
const service = new BrowserService({ dataDir: home, executablePath });

interface Tally {
  bytes: number;
  pictures: number;
  keyframes: number;
}

/** A remote viewer over a binary connection; `video` asks for video instead of JPEG. */
function viewer(connectionId: string, video: boolean) {
  const tally: Tally = { bytes: 0, pictures: 0, keyframes: 0 };
  let counting = false;
  const assembler = new StreamAssembler();
  const bridge = connectBrowser(service, {
    connectionId,
    authorize: () => true,
    send: () => true,
    sendStream: (pieces) => {
      for (const piece of pieces) {
        if (counting) tally.bytes += piece.length;
        const envelope = assembler.push(piece);
        const message = envelope && decodeStreamMessage(envelope);
        if (!message) continue;
        const sequence =
          message.kind === "browser.video" ? message.chunk.sequence : message.frame.sequence;
        const isVideo = message.kind === "browser.video";
        if (counting && isVideo === video) tally.pictures++;
        if (counting && message.kind === "browser.video" && message.chunk.key) tally.keyframes++;
        setTimeout(
          () =>
            void bridge.handle({
              type: "browser.ack",
              threadId: "bench",
              requestId: `${connectionId}-ack`,
              sequence,
              ...(isVideo ? { video: true } : {}),
            }),
          ackDelayMs,
        );
      }
      return true;
    },
  });
  return {
    tally,
    bridge,
    count: () => {
      counting = true;
    },
    subscribe: () =>
      bridge.handle({
        type: "browser.subscribe",
        threadId: "bench",
        requestId: `${connectionId}-subscribe`,
        binaryFrames: true,
        viewport: pane,
        ...(video ? { video: { codecs: ["avc1.42E033", "vp8"] } } : {}),
      }),
  };
}

try {
  await service.open({ threadId: "bench", workspaceId: "bench" });
  await service.execute("bench", {
    action: "navigate",
    url: `http://127.0.0.1:${address.port}/`,
  });
  await service.execute("bench", { action: "resize", width: pane.width, height: pane.height });
  const jpeg = viewer("jpeg-viewer", false);
  const video = viewer("video-viewer", true);
  await jpeg.subscribe();
  await video.subscribe();
  // Let the encoder start and the first keyframe land before counting.
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  jpeg.count();
  video.count();
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  jpeg.bridge.close();
  video.bridge.close();
  const ratio = video.tally.bytes / Math.max(1, jpeg.tally.bytes);
  const result = {
    path: `${seconds} s scroll, ${pane.width}x${pane.height} pane at DPR ${pane.devicePixelRatio}, acks after ${ackDelayMs} ms`,
    jpegBytes: jpeg.tally.bytes,
    jpegFramesPerSecond: Number((jpeg.tally.pictures / seconds).toFixed(1)),
    videoBytes: video.tally.bytes,
    videoFramesPerSecond: Number((video.tally.pictures / seconds).toFixed(1)),
    videoKeyframes: video.tally.keyframes,
    videoToJpegRatio: Number(ratio.toFixed(3)),
    videoMegabitsPerSecond: Number(((video.tally.bytes * 8) / seconds / 1e6).toFixed(2)),
    jpegMegabitsPerSecond: Number(((jpeg.tally.bytes * 8) / seconds / 1e6).toFixed(2)),
  };
  console.log(JSON.stringify(result));
  const failures: string[] = [];
  if (!video.tally.pictures) failures.push("no video reached the viewer");
  if (ratio > 0.4) failures.push(`video is ${ratio.toFixed(3)} of JPEG's bytes (> 0.40)`);
  if (video.tally.pictures / seconds < 15)
    failures.push(`video played ${(video.tally.pictures / seconds).toFixed(1)} fps (< 15)`);
  if (failures.length) {
    console.error(`video wire budget: ${failures.join("; ")}`);
    process.exitCode = 1;
  }
} finally {
  await service.close();
  server.closeAllConnections();
  server.close();
  await rm(home, { recursive: true, force: true });
}
