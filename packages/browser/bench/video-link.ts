import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserService, connectBrowser, detectChromium } from "../src/index.ts";
import { decodeStreamMessage, StreamAssembler } from "../src/stream.ts";

/*
 * How steady a remote video viewer's frame rate is over a phone-like link, in real headless
 * Chrome. The viewer sits behind a simulated link: chunks queue at the link's bandwidth, then
 * take the one-way delay plus jitter; acks take the delay back. Reports frames shown per second
 * (median, p10, min) and the longest gap between two frames. Part of `check:perf`: fails when
 * the median falls below 55 fps or the p10 below 45 fps (a steady 60 fps view, ADR 0088
 * amendment). Skipped where no Chrome is installed.
 *
 * ACE_VIDEO_LINK_SECONDS, ACE_VIDEO_LINK_MBPS, ACE_VIDEO_LINK_RTT_MS and
 * ACE_VIDEO_LINK_JITTER_MS change the run.
 */

const seconds = Number(process.env.ACE_VIDEO_LINK_SECONDS ?? 20);
const megabits = Number(process.env.ACE_VIDEO_LINK_MBPS ?? 25);
const rttMs = Number(process.env.ACE_VIDEO_LINK_RTT_MS ?? 120);
const jitterMs = Number(process.env.ACE_VIDEO_LINK_JITTER_MS ?? 30);
const enforce = process.env.ACE_VIDEO_LINK_REPORT_ONLY !== "1";
const pane = { width: 1280, height: 800, devicePixelRatio: 2 };
const executablePath = await detectChromium();
if (!executablePath) {
  console.log(JSON.stringify({ path: "video link", skipped: "no Chrome or Chromium installed" }));
  process.exit(0);
}

const paragraphs = Array.from(
  { length: 600 },
  (_, index) =>
    `<p>${index}. Remote browser view over a phone link: sharp text and smooth scrolling. The quick brown fox jumps over the lazy dog, 0123456789.</p>`,
).join("");
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end(`<!doctype html><title>Scroll</title>
    <body style="margin:24px;font:16px/1.5 system-ui;color:#1d1d1f;background:#fff">${paragraphs}
    <script>let y = 0; const step = () => { y = (y + 4) % 30000; scrollTo(0, y); requestAnimationFrame(step); }; requestAnimationFrame(step);</script>`);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Missing server address");
const home = await mkdtemp(join(tmpdir(), "ace-video-link-"));
const service = new BrowserService({ dataDir: home, executablePath });

const oneWay = rttMs / 2;
const bytesPerMs = (megabits * 1e6) / 8 / 1000;
const jitter = () => Math.random() * jitterMs;

const shown: number[] = [];
let bytes = 0;
let keyframes = 0;
let counting = false;
/** When the link finishes sending what is queued on it. */
let linkFreeAt = 0;
const assembler = new StreamAssembler();
const bridge = connectBrowser(service, {
  connectionId: "phone",
  authorize: () => true,
  send: () => true,
  sendStream: (pieces) => {
    for (const piece of pieces) {
      const now = performance.now();
      linkFreeAt = Math.max(linkFreeAt, now) + piece.length / bytesPerMs;
      const arrives = linkFreeAt + oneWay + jitter();
      const envelope = assembler.push(piece);
      const message = envelope && decodeStreamMessage(envelope);
      if (counting) bytes += piece.length;
      if (!message || message.kind !== "browser.video") continue;
      const { sequence, key } = message.chunk;
      setTimeout(() => {
        if (counting) {
          shown.push(performance.now());
          if (key) keyframes++;
        }
        setTimeout(
          () =>
            void bridge.handle({
              type: "browser.ack",
              threadId: "bench",
              requestId: "phone-ack",
              sequence,
              video: true,
            }),
          oneWay + jitter(),
        );
      }, arrives - now);
    }
    return true;
  },
});

try {
  await service.open({ threadId: "bench", workspaceId: "bench" });
  await service.execute("bench", { action: "navigate", url: `http://127.0.0.1:${address.port}/` });
  await service.execute("bench", { action: "resize", width: pane.width, height: pane.height });
  await bridge.handle({
    type: "browser.subscribe",
    threadId: "bench",
    requestId: "phone-subscribe",
    binaryFrames: true,
    viewport: pane,
    video: { codecs: ["avc1.42E033", "vp8"] },
  });
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const start = performance.now();
  counting = true;
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  counting = false;
  bridge.close();
  const perSecond = Array.from({ length: seconds }, (_, index) => {
    const from = start + index * 1000;
    return shown.filter((at) => at >= from && at < from + 1000).length;
  });
  const sorted = perSecond.toSorted((a, b) => a - b);
  let longestGap = 0;
  for (let index = 1; index < shown.length; index++)
    longestGap = Math.max(longestGap, (shown[index] ?? 0) - (shown[index - 1] ?? 0));
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const p10 = sorted[Math.floor(sorted.length / 10)] ?? 0;
  console.log(
    JSON.stringify({
      path: `${seconds} s scroll over ${megabits} Mbit/s, ${rttMs} ms RTT, ${jitterMs} ms jitter`,
      framesPerSecond: perSecond,
      median,
      p10,
      min: sorted[0] ?? 0,
      longestGapMs: Math.round(longestGap),
      keyframes,
      megabitsPerSecond: Number(((bytes * 8) / seconds / 1e6).toFixed(2)),
    }),
  );
  if (enforce && (median < 55 || p10 < 45)) {
    console.error(`video link: median ${median} fps, p10 ${p10} fps (want >= 55 and >= 45)`);
    process.exitCode = 1;
  }
} finally {
  await service.close();
  server.closeAllConnections();
  server.close();
  await rm(home, { recursive: true, force: true });
}
