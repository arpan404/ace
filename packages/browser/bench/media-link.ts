import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MediaRuntime } from "@ace/media/runtime";
import { nodeMediaHost, systemMediaClock, type MediaSettings } from "@ace/media/supervisor";
import { MediaTestClient } from "@ace/media/testing/media-test-client";
import { BrowserService, connectBrowser, detectChromium } from "../src/index.ts";
import type { BrowserMedia } from "../src/media-video.ts";
import { decodeStreamMessage, StreamAssembler } from "../src/stream.ts";
import { seededRandom, SimpleLink } from "./link-model.ts";

/*
 * Live video delivered by ace-media (D1), beside `video-link.ts`, which keeps measuring the
 * daemon's own path. Real headless Chrome streams a scrolling page into a real ace-media; a
 * standalone media-connection client (`@ace/media/testing/media-test-client`) takes the pieces
 * behind the same simulated phone link `video-link.ts` uses, and acks each one back up it.
 *
 * Three runs:
 *
 * 1. **The link.** ace-media delivers over the default link (25 Mbit/s, 120 ms, 30 ms jitter):
 *    frames shown per second, median and p10, and the bytes the daemon sent for video on the
 *    main socket, which must be none.
 * 2. **The local hop, legacy.** No link: glass to glass (capture → arrival) on the daemon's own
 *    path, `media.delivery: legacy`.
 * 3. **The local hop, ace-media.** The same through ace-media. The hop is the difference of
 *    the two p95s.
 *
 * Part of `check:perf`: it fails when the median is below 59 fps or the p10 below 55, when the
 * daemon sent any video bytes, or when the hop adds more than 2 ms at p95, unless the one-minute
 * load average is 24 or more, in which case it reports and marks the numbers owed. Skipped where
 * no Chrome or no built ace-media is found (`ACE_MEDIA_TEST_BINARY`, or `native/media/target`).
 * ACE_MEDIA_LINK_SECONDS changes run 1's length; ACE_MEDIA_LINK_REPORT_ONLY=1 never fails.
 */

const seconds = Number(process.env.ACE_MEDIA_LINK_SECONDS ?? 20);
const hopSeconds = 10;
const enforce = process.env.ACE_MEDIA_LINK_REPORT_ONLY !== "1";
const pane = { width: 1280, height: 800, devicePixelRatio: 2 };
const root = new URL("../../../native/media/target/", import.meta.url);
const binary =
  process.env.ACE_MEDIA_TEST_BINARY?.trim() ||
  ["release", "debug"]
    .map((build) => fileURLToPath(new URL(`${build}/ace-media`, root)))
    .find((path) => existsSync(path));
const executablePath = await detectChromium();
if (!executablePath || !binary) {
  console.log(
    JSON.stringify({
      path: "media link",
      skipped: executablePath ? "no built ace-media" : "no Chrome or Chromium installed",
    }),
  );
  process.exit(0);
}

const clock = () => performance.timeOrigin + performance.now();
const when = (time: number, run: () => void) => setTimeout(run, Math.max(0, time - clock()));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const paragraphs = Array.from(
  { length: 600 },
  (_, index) =>
    `<p>${index}. Live video delivered by ace-media: sharp text and smooth scrolling. The quick brown fox jumps over the lazy dog, 0123456789.</p>`,
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

const home = await mkdtemp(join(tmpdir(), "ace-media-link-"));
let settings: MediaSettings = {
  encode: "auto",
  delivery: "auto",
  recordings: "legacy",
  stills: "legacy",
};
let ids = 0;
const runtime = new MediaRuntime({
  version: execFileSync(binary, ["--version"]).toString().trim(),
  binary,
  runtimeDir: home,
  dataDir: home,
  settings: () => settings,
  host: nodeMediaHost(process.env),
  clock: systemMediaClock,
  random: Math.random,
  listen: () => ({ message: { type: "listen", loopback: true }, payload: new Uint8Array(0) }),
  id: () => `bench-${++ids}`,
  log: () => {},
});
const media: BrowserMedia = {
  add: (producer) => runtime.sources.add(producer),
  routed: (kind) => runtime.sources.routed(kind),
  wanted: (kind) => runtime.sources.wanted(kind),
  pictureCodecs: () => runtime.pictureCodecs(),
  endpoint: () => runtime.sources.endpoint(),
};
const service = new BrowserService({ dataDir: home, executablePath, now: clock, media });

type Shown = { arrivedAt: number; capturedAt: number };
/** Video bytes the daemon sent on its main socket. */
let daemonVideoBytes = 0;
let sessions = 0;

/**
 * One viewer for `ms`: through ace-media on a media connection when `delivered`, else on the
 * daemon's own socket; behind `link`, or straight on loopback.
 */
async function watch(delivered: boolean, link: SimpleLink | undefined, ms: number) {
  const shown: Shown[] = [];
  const assembler = new StreamAssembler();
  let counting = false;
  const id = `bench-session-${++sessions}`;
  const owner = {
    session: id,
    device: "bench-phone",
    admission: { kind: "pairing", generation: "bench-credential" },
  } as const;
  const take = (piece: Uint8Array, ack: (sequence: number) => void) => {
    const at = clock();
    const arrives = link ? (link.sendAll([{ bytes: piece.length, at }])[0] ?? at) : at;
    const envelope = assembler.push(piece);
    const message = envelope && decodeStreamMessage(envelope);
    if (message?.kind !== "browser.video") return;
    const { sequence, timestamp } = message.chunk;
    when(arrives, () => {
      if (counting) shown.push({ arrivedAt: arrives, capturedAt: timestamp });
      // Acks go back up the same link, as small messages.
      when(link ? clock() + 60 : clock(), () => ack(sequence));
    });
  };
  let client: MediaTestClient | undefined;
  let poster: { ms: number; bytes: number } | undefined;
  let subscribedAt = 0;
  const bridge = connectBrowser(service, {
    connectionId: id,
    authorize: () => true,
    send: (message) => {
      if (message.type === "browser.result" && message.media?.poster)
        poster = {
          ms: clock() - subscribedAt,
          bytes: Buffer.from(message.media.poster.jpeg, "base64").length,
        };
      return true;
    },
    local: link === undefined,
    media: { owner: () => owner, delivery: () => runtime.delivery() },
    sendStream: (pieces) => {
      for (const piece of pieces) {
        daemonVideoBytes += piece.length;
        take(
          piece,
          (sequence) =>
            void bridge.handle({
              type: "browser.ack",
              threadId: "bench",
              requestId: "ack",
              sequence,
              video: true,
            }),
        );
      }
      return true;
    },
  });
  const subscribe = {
    type: "browser.subscribe",
    threadId: "bench",
    requestId: "subscribe",
    binaryFrames: true,
    viewport: pane,
    video: { codecs: ["hvc1.1.6.L153.B0", "avc1.640033", "avc1.42E033", "vp8"] },
  };
  if (delivered) {
    const grant = await runtime.connections.connect(owner);
    if (!grant.ok) throw new Error(`media.connect: ${grant.code}`);
    const opened = await MediaTestClient.open(grant, {
      onPiece: (piece) =>
        take(piece, (sequence) =>
          opened.send({ type: "browser.ack", threadId: "bench", sequence, video: true }),
        ),
    });
    client = opened;
    subscribedAt = clock();
    await bridge.handle({ ...subscribe, media: { connection: grant.connection } });
  } else await bridge.handle(subscribe);
  await sleep(3_000);
  const start = clock();
  const before = daemonVideoBytes;
  counting = true;
  await sleep(ms);
  counting = false;
  const sent = daemonVideoBytes - before;
  client?.close();
  bridge.close();
  return { shown, start, sent, poster };
}

function quantile(values: readonly number[], q: number): number | null {
  const sorted = values.toSorted((a, b) => a - b);
  if (sorted.length === 0) return null;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0);
}

try {
  runtime.settingsChanged();
  await service.open({ threadId: "bench", workspaceId: "bench", profile: "persistent" });
  await service.execute("bench", { action: "navigate", url: `http://127.0.0.1:${address.port}/` });
  await service.execute("bench", { action: "resize", width: pane.width, height: pane.height });

  const phone = new SimpleLink(25, 60, 30, seededRandom(1));
  const linked = await watch(true, phone, seconds * 1000);
  const perSecond = Array.from({ length: seconds }, (_, index) => {
    const from = linked.start + index * 1000;
    return linked.shown.filter(({ arrivedAt }) => arrivedAt >= from && arrivedAt < from + 1000)
      .length;
  });
  const sorted = perSecond.toSorted((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const p10 = sorted[Math.floor(sorted.length / 10)] ?? 0;

  settings = { ...settings, delivery: "legacy" };
  runtime.settingsChanged();
  const legacy = await watch(false, undefined, hopSeconds * 1000);
  settings = { ...settings, delivery: "auto" };
  runtime.settingsChanged();
  const direct = await watch(true, undefined, hopSeconds * 1000);
  const g2g = (shown: Shown[]) => shown.map(({ arrivedAt, capturedAt }) => arrivedAt - capturedAt);
  const legacyP95 = quantile(g2g(legacy.shown), 0.95);
  const directP95 = quantile(g2g(direct.shown), 0.95);
  const hopMs =
    legacyP95 === null || directP95 === null ? null : Math.max(0, directP95 - legacyP95);

  const load = loadavg()[0] ?? 0;
  const enforced = enforce && load < 24;
  console.log(
    JSON.stringify({
      path: `${seconds} s scroll through ace-media over phone: 25 Mbit/s, 120 ms RTT, 30 ms jitter`,
      framesPerSecond: perSecond,
      median,
      p10,
      min: sorted[0] ?? 0,
      daemonVideoBytes: linked.sent + direct.sent,
      glassToGlassLoopbackP95Ms: { legacy: legacyP95, aceMedia: directP95 },
      hopMs,
      // The subscribe reply's poster on this machine, and when it would arrive on 3g-400: one
      // round trip (400 ms) and its bytes at 400 kbit/s.
      poster: direct.poster
        ? {
            localMs: Math.round(direct.poster.ms),
            bytes: direct.poster.bytes,
            on3g400Ms: Math.round(direct.poster.ms + 400 + (direct.poster.bytes * 8) / 400),
          }
        : null,
      loadAverage: Number(load.toFixed(2)),
      cores: availableParallelism(),
      enforced,
      ...(enforced ? {} : { owed: "load average 24 or more: numbers to be measured again" }),
    }),
  );
  if (enforced) {
    const misses = [
      median < 59 && `median ${median} fps (want >= 59)`,
      p10 < 55 && `p10 ${p10} fps (want >= 55)`,
      linked.sent + direct.sent > 0 && `daemon sent ${linked.sent + direct.sent} video bytes`,
      (hopMs ?? Infinity) > 2 && `local hop ${hopMs} ms at p95 (want <= 2)`,
    ].filter((miss) => typeof miss === "string");
    if (misses.length > 0) {
      console.error(`media link: ${misses.join("; ")}`);
      process.exitCode = 1;
    }
  }
} finally {
  await service.close();
  runtime.dispose();
  server.closeAllConnections();
  server.close();
  await rm(home, { recursive: true, force: true });
}
