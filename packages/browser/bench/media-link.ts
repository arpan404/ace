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
import {
  seededRandom,
  SimpleLink,
  threeGLink,
  threeGProfiles,
  type Path,
  type ThreeGProfileName,
} from "./link-model.ts";

/*
 * Live video delivered by ace-media (D1), the only delivery since X3. Real headless Chrome
 * streams a scrolling page into a real ace-media; a standalone media-connection client
 * (`@ace/media/testing/media-test-client`) takes the pieces behind a simulated phone link
 * (`link-model.ts`), and acks each one back up it.
 *
 * Three runs:
 *
 * 1. **The link.** ace-media delivers over the default link (25 Mbit/s, 120 ms, 30 ms jitter):
 *    frames shown per second, median and p10, and the bytes the daemon sent for video on the
 *    main socket, which must be none.
 * 2. **The local hop.** No link: glass to glass (capture → arrival) through ace-media.
 * 3. **An old client.** A viewer that names no media connection: it gets no pictures, and the
 *    daemon still sends no video bytes (X3's "Bytes").
 * 4. **3G** (ADR 0149): ace-media's own delivery over the relay legs of `3g-1600` and `3g-400`,
 *    the viewer's link hint saying so: frames shown per second, the coded width at p50, and glass
 *    to glass at p50. The bars are the old 3G gate's: `3g-1600` at least 15 fps median, at least
 *    1152 px wide at p50 and at most 1 s glass to glass at p50; `3g-400` at most 1.5 s glass to
 *    glass at p50. Report only while the load average is above twice the cores.
 *
 * Part of `check:perf`: it fails when the median is below 59 fps or the p10 below 55, or when
 * the daemon sent any video bytes, unless the one-minute load average is 24 or more, in which
 * case it reports and marks the numbers owed; and when a 3G bar is missed on a quiet machine. Skipped where no Chrome or no built ace-media is
 * found (`ACE_MEDIA_TEST_BINARY`, or `native/media/target`). ACE_MEDIA_LINK_SECONDS changes run
 * 1's length; ACE_MEDIA_LINK_REPORT_ONLY=1 never fails.
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
  recordings: "auto",
  stills: "auto",
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

type Shown = { arrivedAt: number; capturedAt: number; codedWidth: number };
/** An ack on the wire: its JSON and the relay channel's framing. */
const ackBytes = 120;
/** Video bytes the daemon sent on its main socket. */
let daemonVideoBytes = 0;
let sessions = 0;

/**
 * One viewer for `ms`: through ace-media on a media connection when `delivered`, else on the
 * daemon's own socket; behind `link`, or straight on loopback.
 */
async function watch(
  delivered: boolean,
  link: Path | undefined,
  ms: number,
  threeG?: (typeof threeGProfiles)[ThreeGProfileName],
  /** The link back up, for the acks: its serialization, loss and jitter pace the view. */
  uplink?: Path,
) {
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
    const { sequence, timestamp, codedWidth } = message.chunk;
    when(arrives, () => {
      if (counting) shown.push({ arrivedAt: arrives, capturedAt: timestamp, codedWidth });
      // Acks go back up as small messages: through the modelled uplink where there is one.
      const now = clock();
      const acked = uplink ? uplink.send(ackBytes, now) : now + (link ? 60 : 0);
      when(acked, () => ack(sequence));
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
    viewport: threeG
      ? {
          ...pane,
          link: { effectiveType: "3g", downlinkKbps: threeG.downKbps, rttMs: threeG.rttMs },
        }
      : pane,
    video: { codecs: ["hvc1.1.6.L153.B0", "avc1.640033", "avc1.42E033", "vp8"] },
    mediaClient: true,
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
  } else {
    // An older client: it names no media connection, nor that it takes one.
    const { mediaClient: _current, ...old } = subscribe;
    await bridge.handle(old);
  }
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

  const direct = await watch(true, undefined, hopSeconds * 1000);
  /** ace-media's delivery over a 3G profile's relay legs (ADR 0149). */
  const overThreeG = async (name: ThreeGProfileName) => {
    const profile = threeGProfiles[name];
    const { down, up } = threeGLink(profile, seededRandom(7), clock());
    const run = await watch(true, down, seconds * 1000, profile, up);
    const counts = Array.from({ length: seconds }, (_, index) => {
      const from = run.start + index * 1000;
      return run.shown.filter(({ arrivedAt }) => arrivedAt >= from && arrivedAt < from + 1000)
        .length;
    }).toSorted((a, b) => a - b);
    return {
      fpsMedian: counts[Math.floor(counts.length / 2)] ?? 0,
      codedWidthP50: quantile(
        run.shown.map((one) => one.codedWidth),
        0.5,
      ),
      glassToGlassP50Ms: quantile(
        run.shown.map(({ arrivedAt, capturedAt }) => arrivedAt - capturedAt),
        0.5,
      ),
      sent: run.sent,
    };
  };
  const threeG1600 = await overThreeG("3g-1600");
  const threeG400 = await overThreeG("3g-400");
  const old = await watch(false, undefined, hopSeconds * 1000);
  const g2g = (shown: Shown[]) => shown.map(({ arrivedAt, capturedAt }) => arrivedAt - capturedAt);
  const directP95 = quantile(g2g(direct.shown), 0.95);
  const videoBytes = linked.sent + direct.sent + old.sent + threeG1600.sent + threeG400.sent;

  const load = loadavg()[0] ?? 0;
  const enforced = enforce && load < 24;
  console.log(
    JSON.stringify({
      path: `${seconds} s scroll through ace-media over phone: 25 Mbit/s, 120 ms RTT, 30 ms jitter`,
      framesPerSecond: perSecond,
      median,
      p10,
      min: sorted[0] ?? 0,
      daemonVideoBytes: videoBytes,
      oldClientPictures: old.shown.length,
      glassToGlassLoopbackP95Ms: directP95,
      "3g-1600": threeG1600,
      "3g-400": threeG400,
      threeGEnforced: enforce && load <= 2 * availableParallelism(),
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
      videoBytes > 0 && `daemon sent ${videoBytes} video bytes`,
      old.shown.length > 0 &&
        `a viewer without a media connection got ${old.shown.length} pictures`,
    ].filter((miss) => typeof miss === "string");
    if (misses.length > 0) {
      console.error(`media link: ${misses.join("; ")}`);
      process.exitCode = 1;
    }
  }
  // The 3G bars (ADR 0149), against ace-media's own delivery: report only on a busy machine.
  if (enforce && load <= 2 * availableParallelism()) {
    const misses = [
      threeG1600.fpsMedian < 15 && `3g-1600 median ${threeG1600.fpsMedian} fps (want >= 15)`,
      (threeG1600.codedWidthP50 ?? 0) < 1152 &&
        `3g-1600 width ${threeG1600.codedWidthP50} px at p50 (want >= 1152)`,
      (threeG1600.glassToGlassP50Ms ?? Infinity) > 1_000 &&
        `3g-1600 glass to glass ${threeG1600.glassToGlassP50Ms} ms at p50 (want <= 1000)`,
      (threeG400.glassToGlassP50Ms ?? Infinity) > 1_500 &&
        `3g-400 glass to glass ${threeG400.glassToGlassP50Ms} ms at p50 (want <= 1500)`,
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
