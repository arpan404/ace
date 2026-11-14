import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { BrowserService, connectBrowser, detectChromium } from "../src/index.ts";
import { decodeStreamMessage, StreamAssembler } from "../src/stream.ts";
import {
  isThreeGProfile,
  seededRandom,
  SimpleLink,
  threeGLink,
  threeGProfiles,
  type LinkProfile,
  type Path,
  type TcpLeg,
} from "./link-model.ts";

/*
 * How a remote video viewer fares over a phone-like link, in real headless Chrome. The viewer
 * sits behind a simulated link (`link-model.ts`) that carries the daemon's video down and the
 * viewer's subscribe, acks and taps up. Reports frames shown per second (median, p10, min), the
 * longest gap between two frames, the bit rate, and three delays (see the README):
 *
 * - **time to first picture:** the viewer sends its subscribe → the first keyframe has fully
 *   arrived at the viewer (decode time is not simulated);
 * - **glass to glass:** a chunk's capture timestamp (when its frame entered the encoder, on the
 *   daemon's clock) → the chunk fully arrived at the viewer, p50 and p95;
 * - **tap to picture:** the viewer sends a key press → the first chunk captured after the page
 *   painted its response has fully arrived, p50 and p95, one tap every 2 s.
 *
 * The default `phone` profile (25 Mbit/s, 120 ms, 30 ms jitter, no loss) is part of
 * `check:perf`: it fails when the median falls below 55 fps or the p10 below 45 fps (a steady
 * 60 fps view, ADR 0088 amendment). The 3G profiles (ADR 0149) report only until their profile
 * says `enforced` (M2b), and then fail below their targets, unless the load average is above
 * twice the core count. Skipped where no Chrome is installed.
 *
 * ACE_VIDEO_LINK_PROFILE picks `3g-400`, `3g-800` or `3g-1600` (or `ephemeral`, the old way to
 * ask for a private context). ACE_VIDEO_LINK_SECONDS, ACE_VIDEO_LINK_SEED and
 * ACE_VIDEO_LINK_CONTEXT=ephemeral change any run; ACE_VIDEO_LINK_MBPS, ACE_VIDEO_LINK_RTT_MS and
 * ACE_VIDEO_LINK_JITTER_MS change the `phone` link. ACE_VIDEO_LINK_REPORT_ONLY=1 never fails.
 */

const seconds = Number(process.env.ACE_VIDEO_LINK_SECONDS ?? 20);
const seed = Number(process.env.ACE_VIDEO_LINK_SEED ?? 1);
const enforce = process.env.ACE_VIDEO_LINK_REPORT_ONLY !== "1";
const linkName = process.env.ACE_VIDEO_LINK_PROFILE;
const threeG: LinkProfile | undefined = isThreeGProfile(linkName)
  ? threeGProfiles[linkName]
  : undefined;
const context =
  linkName === "ephemeral" || process.env.ACE_VIDEO_LINK_CONTEXT === "ephemeral"
    ? "ephemeral"
    : "persistent";
const megabits = threeG ? threeG.downKbps / 1000 : Number(process.env.ACE_VIDEO_LINK_MBPS ?? 25);
const rttMs = threeG?.rttMs ?? Number(process.env.ACE_VIDEO_LINK_RTT_MS ?? 120);
const jitterMs = threeG?.jitterMs ?? Number(process.env.ACE_VIDEO_LINK_JITTER_MS ?? 30);
const pane = { width: 1280, height: 800, devicePixelRatio: 2 };
const executablePath = await detectChromium();
if (!executablePath) {
  console.log(JSON.stringify({ path: "video link", skipped: "no Chrome or Chromium installed" }));
  process.exit(0);
}

/** One clock for the daemon's stamps, the page's and the link's: epoch milliseconds. */
const clock = () => performance.timeOrigin + performance.now();
const when = (time: number, run: () => void) => setTimeout(run, Math.max(0, time - clock()));

const paragraphs = Array.from(
  { length: 600 },
  (_, index) =>
    `<p>${index}. Remote browser view over a phone link: sharp text and smooth scrolling. The quick brown fox jumps over the lazy dog, 0123456789.</p>`,
).join("");
// A key press flips the background; the frame that paints it stamps the time (`aceTaps`).
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end(`<!doctype html><title>Scroll</title>
    <body style="margin:24px;font:16px/1.5 system-ui;color:#1d1d1f;background:#fff">${paragraphs}
    <script>let y = 0; const step = () => { y = (y + 4) % 30000; scrollTo(0, y); requestAnimationFrame(step); }; requestAnimationFrame(step);
    const taps = (window.aceTaps = []); let dark = false;
    addEventListener("keydown", () => { dark = !dark; document.body.style.background = dark ? "#ffd60a" : "#fff"; requestAnimationFrame(() => taps.push(performance.timeOrigin + performance.now())); });</script>`);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Missing server address");
const home = await mkdtemp(join(tmpdir(), "ace-video-link-"));
const service = new BrowserService({ dataDir: home, executablePath, now: clock });

const random = seededRandom(seed);
let down: Path;
let up: Path;
let radio: TcpLeg | undefined;
if (threeG) {
  ({ down, up, radio } = threeGLink(threeG, random, clock()));
} else {
  down = new SimpleLink(megabits, rttMs / 2, jitterMs, random);
  // Acks are tiny: they only take the delay back.
  const ack = (time: number) => time + rttMs / 2 + random() * jitterMs;
  up = {
    send: (_bytes, time) => ack(time),
    sendAll: (messages) => messages.map(({ at }) => ack(at)),
  };
}
/** Sends a viewer's message up the link and hands it to the daemon when it arrives. */
const sendUp = (message: Parameters<typeof bridge.handle>[0]) =>
  when(up.send(JSON.stringify(message).length, clock()), () => void bridge.handle(message));

interface Shown {
  arrivedAt: number;
  capturedAt: number;
  codedWidth: number;
}
const shown: Shown[] = [];
const arrivals: { at: number; bytes: number }[] = [];
let bytes = 0;
let keyframes = 0;
let subscribedAt = 0;
let firstPictureAt: number | undefined;
const codecs = new Set<string>();
let counting = false;
const assembler = new StreamAssembler();
const bridge = connectBrowser(service, {
  connectionId: "phone",
  authorize: () => true,
  send: () => true,
  sendStream: (pieces) => {
    const now = clock();
    const landings = down.sendAll(pieces.map((piece) => ({ bytes: piece.length, at: now })));
    for (const [index, piece] of pieces.entries()) {
      const arrives = landings[index] ?? now;
      const envelope = assembler.push(piece);
      const message = envelope && decodeStreamMessage(envelope);
      if (counting) {
        bytes += piece.length;
        arrivals.push({ at: now, bytes: piece.length });
      }
      if (!message || message.kind !== "browser.video") continue;
      const { sequence, key, timestamp, codedWidth } = message.chunk;
      if (counting) codecs.add(message.chunk.codec);
      when(arrives, () => {
        if (key && firstPictureAt === undefined) firstPictureAt = arrives;
        if (counting) {
          shown.push({ arrivedAt: arrives, capturedAt: timestamp, codedWidth });
          if (key) keyframes++;
        }
        sendUp({
          type: "browser.ack",
          threadId: "bench",
          requestId: "phone-ack",
          sequence,
          video: true,
        });
      });
    }
    return true;
  },
});

/** The value at quantile `q` of `values`, or null for none. */
function quantile(values: readonly number[], q: number): number | null {
  const sorted = values.toSorted((a, b) => a - b);
  if (sorted.length === 0) return null;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0);
}

const tapsSent: number[] = [];
const tapTimer = setInterval(() => {
  if (!counting) return;
  tapsSent.push(clock());
  sendUp({
    type: "browser.input",
    threadId: "bench",
    requestId: `tap-${tapsSent.length}`,
    input: { kind: "key", event: "keyDown", key: "t", code: "KeyT", text: "t", modifiers: 0 },
  });
  sendUp({
    type: "browser.input",
    threadId: "bench",
    requestId: `tap-up-${tapsSent.length}`,
    input: { kind: "key", event: "keyUp", key: "t", code: "KeyT", modifiers: 0 },
  });
}, 2_000);

try {
  await service.open({ threadId: "bench", workspaceId: "bench", profile: context });
  await service.execute("bench", { action: "navigate", url: `http://127.0.0.1:${address.port}/` });
  await service.execute("bench", { action: "resize", width: pane.width, height: pane.height });
  subscribedAt = clock();
  sendUp({
    type: "browser.subscribe",
    threadId: "bench",
    requestId: "phone-subscribe",
    binaryFrames: true,
    viewport: pane,
    // What a current web client offers (apps/web lib/video/codecs.ts), HEVC first.
    video: { codecs: ["hvc1.1.6.L153.B0", "avc1.640033", "avc1.42E033", "vp8"] },
  });
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const start = clock();
  counting = true;
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  counting = false;
  clearInterval(tapTimer);
  const painted = z.array(z.number()).parse(
    JSON.parse(
      String(
        await service.execute("bench", {
          action: "evaluate",
          expression: "JSON.stringify(window.aceTaps)",
        }),
      ),
    ),
  );
  bridge.close();
  const perSecond = Array.from({ length: seconds }, (_, index) => {
    const from = start + index * 1000;
    return shown.filter(({ arrivedAt }) => arrivedAt >= from && arrivedAt < from + 1000).length;
  });
  const sentMegabits = Array.from({ length: seconds }, (_, index) => {
    const from = start + index * 1000;
    const sum = arrivals
      .filter((entry) => entry.at >= from && entry.at < from + 1000)
      .reduce((total, entry) => total + entry.bytes, 0);
    return Number(((sum * 8) / 1e6).toFixed(1));
  });
  const sorted = perSecond.toSorted((a, b) => a - b);
  let longestGap = 0;
  for (let index = 1; index < shown.length; index++)
    longestGap = Math.max(
      longestGap,
      (shown[index]?.arrivedAt ?? 0) - (shown[index - 1]?.arrivedAt ?? 0),
    );
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const p10 = sorted[Math.floor(sorted.length / 10)] ?? 0;
  const glassToGlass = shown.map(({ arrivedAt, capturedAt }) => arrivedAt - capturedAt);
  const tapToPicture = tapsSent.flatMap((sentAt, index) => {
    const paintedAt = painted[index];
    if (paintedAt === undefined) return [];
    const showing = shown.find(({ capturedAt }) => capturedAt >= paintedAt);
    return showing ? [showing.arrivedAt - sentAt] : [];
  });
  const firstPictureMs =
    firstPictureAt === undefined ? null : Math.round(firstPictureAt - subscribedAt);
  const codedWidth = quantile(
    shown.map((entry) => entry.codedWidth),
    0.5,
  );
  const load = loadavg()[0] ?? 0;
  const cores = availableParallelism();
  const glassToGlassP50 = quantile(glassToGlass, 0.5);
  console.log(
    JSON.stringify({
      path: `${seconds} s scroll (${context}) over ${threeG?.name ?? "phone"}: ${megabits} Mbit/s, ${rttMs} ms RTT, ${jitterMs} ms jitter${threeG ? `, ${threeG.loss * 100}% loss, slow start, ${(threeG.competing?.bytes ?? 0) / 1000} KB burst every 10 s, seed ${seed}` : ""}`,
      framesPerSecond: perSecond,
      sentMegabits,
      median,
      p10,
      min: sorted[0] ?? 0,
      longestGapMs: Math.round(longestGap),
      keyframes,
      codecs: [...codecs],
      megabitsPerSecond: Number(((bytes * 8) / seconds / 1e6).toFixed(2)),
      codedWidth,
      firstPictureMs,
      // The poster (F2 with D1) doesn't exist yet.
      firstPosterMs: null,
      glassToGlassMs: { p50: glassToGlassP50, p95: quantile(glassToGlass, 0.95) },
      tapToPictureMs: {
        p50: quantile(tapToPicture, 0.5),
        p95: quantile(tapToPicture, 0.95),
        taps: tapsSent.length,
        shown: tapToPicture.length,
      },
      ...(radio ? { radioLosses: radio.losses } : {}),
      loadAverage: Number(load.toFixed(2)),
      cores,
      enforced: threeG ? threeG.enforced && enforce && load <= 2 * cores : enforce,
    }),
  );
  if (!threeG && enforce && (median < 55 || p10 < 45)) {
    console.error(`video link: median ${median} fps, p10 ${p10} fps (want >= 55 and >= 45)`);
    process.exitCode = 1;
  }
  const targets = threeG?.targets;
  if (threeG?.enforced && targets && enforce && load <= 2 * cores) {
    const misses = [
      (firstPictureMs ?? Infinity) > targets.firstPictureMs &&
        `first picture ${firstPictureMs} ms (want <= ${targets.firstPictureMs})`,
      (glassToGlassP50 ?? Infinity) > targets.glassToGlassP50Ms &&
        `glass to glass p50 ${glassToGlassP50} ms (want <= ${targets.glassToGlassP50Ms})`,
      median < targets.fpsMedian && `median ${median} fps (want >= ${targets.fpsMedian})`,
      (codedWidth ?? 0) < targets.codedWidth &&
        `coded width ${codedWidth} (want >= ${targets.codedWidth})`,
    ].filter((miss) => typeof miss === "string");
    if (misses.length > 0) {
      console.error(`video link ${threeG.name}: ${misses.join("; ")}`);
      process.exitCode = 1;
    }
  }
} finally {
  clearInterval(tapTimer);
  await service.close();
  server.closeAllConnections();
  server.close();
  await rm(home, { recursive: true, force: true });
}
