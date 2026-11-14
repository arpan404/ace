import { chromium, type Browser, type BrowserContext, type CDPSession } from "@playwright/test";
import { z } from "zod";
import {
  countsSince,
  linkProfile,
  roundTrips,
  startLinkShaper,
  type LinkCounts,
  type LinkProfile,
  type LinkShaper,
} from "@ace/perf-kit/link";
import { loadChain, type LoadRequest } from "./load-chain.ts";
import { open, withPerfApp } from "./perf-app.ts";
import { withDaemonApp } from "./slow-link-daemon.ts";

/*
 * Navigation over a slow link (ADR 0056): a remote device opening a thread through a tunnel or
 * a phone network. Report only, no budget: it says how many requests and sequential round trips
 * the first screen waits on and when the thread's content is there, for comparing one boot
 * order with another.
 *
 *   node tools/web-perf/src/slow-link.ts [--target=preview|daemon] [--profile=3g-fast]
 *     [--cache=cold,warm]
 *
 * `preview` (the default) is the perf build under `vite preview`, its thread fed by the endless
 * agent, with the link emulated by Chromium (latency and throughput; it cannot drop packets).
 * `daemon` is the production build served by a real daemon from this checkout over its pinned
 * TLS listener, paired as a phone pairs, through the TCP link shaper (@ace/perf-kit/link), which
 * also models loss; its thread is a recorded ~120-item thread (apps/daemon/bench/slow-link-*).
 * `cold` opens with an empty HTTP cache; `warm` opens the same thread again with the cache and
 * the client's kept snapshots from the cold visit.
 */

const argument = (name: string, fallback: string) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const target = z.enum(["preview", "daemon"]).parse(argument("target", "preview"));
const profile = linkProfile(argument("profile", "3g-fast"));
const caches = z.array(z.enum(["cold", "warm"])).parse(argument("cache", "cold,warm").split(","));

const Initiator = z
  .object({
    type: z.string(),
    url: z.string().optional(),
    stack: z
      .object({
        callFrames: z.array(z.object({ url: z.string() })),
        parent: z.unknown().optional(),
      })
      .optional(),
  })
  .passthrough();
const RequestSent = z.object({
  requestId: z.string(),
  timestamp: z.number(),
  request: z.object({ url: z.string() }),
  initiator: Initiator,
  type: z.string().optional(),
});
const LoadingFinished = z.object({
  requestId: z.string(),
  timestamp: z.number(),
  encodedDataLength: z.number(),
});
const Marks = z.object({
  navigationStart: z.number(),
  transcript: z.number().nullable(),
  sidebar: z.number().nullable(),
});

/** Records when the transcript's first message and the sidebar's first thread appear. */
function markFirstContent(): void {
  const marks: { transcript: number | null; sidebar: number | null } = {
    transcript: null,
    sidebar: null,
  };
  Object.assign(globalThis, { aceFirstContent: marks });
  const look = () => {
    if (marks.transcript === null && document.querySelector('[role="feed"] [role="article"]'))
      marks.transcript = performance.now();
    if (
      marks.sidebar === null &&
      document.querySelector('nav a[href^="/t/"], aside a[href^="/t/"]')
    )
      marks.sidebar = performance.now();
    if (marks.transcript !== null && marks.sidebar !== null) observer.disconnect();
  };
  const observer = new MutationObserver(look);
  observer.observe(document, { childList: true, subtree: true });
}

const pathOf = (url: string) => {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
};

function initiatorUrl(initiator: z.infer<typeof Initiator>): string | undefined {
  if (initiator.url) return initiator.url;
  return initiator.stack?.callFrames.find((frame) => frame.url)?.url;
}

interface SlowLinkResult {
  cache: "cold" | "warm";
  transcriptMs: number;
  sidebarMs: number | null;
  requests: number;
  kilobytes: number;
  roundTrips: number;
  path: string[];
  /** Requests before first content by type and initiator, most first. */
  kinds: [string, number][];
  /** Daemon target only: everything that crossed the shaped link, WebSocket frames included. */
  link?: { roundTrips: number; downKilobytes: number; upKilobytes: number; stalls: number };
}

/** Chromium's emulation of a profile: its latency and rates; loss has no equivalent. */
async function emulate(cdp: CDPSession, link: LinkProfile) {
  if (link.downBitsPerSecond === null && link.rttMs === 0) return;
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: link.rttMs,
    downloadThroughput: (link.downBitsPerSecond ?? 0) / 8 || -1,
    uploadThroughput: (link.upBitsPerSecond ?? 0) / 8 || -1,
  });
}

/** One navigation to `url` in `context`, timed to the thread's first message. */
async function navigate(
  context: BrowserContext,
  url: string,
  cache: "cold" | "warm",
  options: { emulated: boolean; shaper?: LinkShaper },
): Promise<SlowLinkResult> {
  const page = await context.newPage();
  try {
    await page.addInitScript(markFirstContent);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    // Cleared, not disabled: the cold visit fills the cache the warm visit then reads.
    if (cache === "cold") await cdp.send("Network.clearBrowserCache");
    if (options.emulated) await emulate(cdp, profile);
    const sent = new Map<string, z.infer<typeof RequestSent>>();
    const bytes = new Map<string, number>();
    const finished = new Map<string, number>();
    cdp.on("Network.requestWillBeSent", (event) => {
      const parsed = RequestSent.safeParse(event);
      if (parsed.success && !sent.has(parsed.data.requestId))
        sent.set(parsed.data.requestId, parsed.data);
    });
    cdp.on("Network.loadingFinished", (event) => {
      const parsed = LoadingFinished.safeParse(event);
      if (!parsed.success) return;
      bytes.set(parsed.data.requestId, parsed.data.encodedDataLength);
      finished.set(parsed.data.requestId, parsed.data.timestamp);
    });
    const before: LinkCounts | undefined = options.shaper?.counts();
    await open(page, url);
    await page
      .getByRole("feed", { name: "Transcript" })
      .getByRole("article")
      .first()
      .waitFor({ timeout: 120_000 });
    await page.waitForFunction(
      () =>
        (globalThis as { aceFirstContent?: { transcript: unknown } }).aceFirstContent?.transcript !=
        null,
    );
    const crossed =
      before && options.shaper ? countsSince(before, options.shaper.counts()) : undefined;
    const marks = Marks.parse(
      await page.evaluate(() => {
        const first = (globalThis as unknown as { aceFirstContent: object }).aceFirstContent;
        return { navigationStart: performance.timeOrigin, ...first };
      }),
    );
    const transcriptMs = marks.transcript ?? Number.NaN;
    const requests = [...sent.values()].filter((entry) => !entry.request.url.startsWith("data:"));
    const navigation = requests.find((entry) => entry.type === "Document") ?? requests[0];
    const startedAt = navigation?.timestamp ?? 0;
    const chain = loadChain(
      requests.map((entry): LoadRequest => ({
        url: pathOf(entry.request.url),
        initiator: entry === navigation ? null : mapInitiator(entry.initiator),
        startMs: (entry.timestamp - startedAt) * 1000,
        endMs: ((finished.get(entry.requestId) ?? Number.POSITIVE_INFINITY) - startedAt) * 1000,
        bytes: bytes.get(entry.requestId) ?? 0,
      })),
      transcriptMs,
    );
    const kinds = new Map<string, number>();
    for (const entry of requests)
      if ((entry.timestamp - startedAt) * 1000 <= transcriptMs) {
        const kind = `${entry.type ?? "?"} from ${entry.initiator.type} ${pathOf(mapInitiator(entry.initiator) ?? "")}`;
        kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      }
    return {
      cache,
      kinds: [...kinds].toSorted((a, b) => b[1] - a[1]).slice(0, 12),
      transcriptMs,
      sidebarMs: marks.sidebar,
      requests: chain.requests,
      kilobytes: chain.bytes / 1024,
      roundTrips: chain.roundTrips,
      path: chain.path,
      ...(crossed
        ? {
            link: {
              roundTrips: roundTrips(crossed),
              downKilobytes: crossed.downBytes / 1024,
              upKilobytes: crossed.upBytes / 1024,
              stalls: crossed.stalls,
            },
          }
        : {}),
    };
  } finally {
    await page.close();
  }
}

function mapInitiator(initiator: z.infer<typeof Initiator>): string | undefined {
  const url = initiatorUrl(initiator);
  return url === undefined || url.startsWith("about:") ? undefined : pathOf(url);
}

const line = (label: string, value: string) =>
  process.stdout.write(`  ${label.padEnd(54)} ${value}\n`);

function reportSlowLink(result: SlowLinkResult): void {
  const down =
    profile.downBitsPerSecond === null
      ? "unshaped"
      : `${profile.downBitsPerSecond / 1e6} Mbit/s down`;
  process.stdout.write(
    `slow link, ${target}, ${profile.name} (${profile.rttMs} ms round trip, ${down}), ${result.cache} cache:\n`,
  );
  line("first thread content (ms)", result.transcriptMs.toFixed(0));
  line("first sidebar row (ms)", result.sidebarMs === null ? "none" : result.sidebarMs.toFixed(0));
  line("requests before first content", String(result.requests));
  line("transferred before first content (KB)", result.kilobytes.toFixed(0));
  line("sequential round trips before first content", String(result.roundTrips));
  if (result.link) {
    line("link round trips, WebSocket included", String(result.link.roundTrips));
    line("link bytes down, WebSocket included (KB)", result.link.downKilobytes.toFixed(0));
  }
  line("deepest chain", result.path.join(" → "));
  for (const [kind, count] of result.kinds) line(`  ${kind}`, String(count));
}

async function run(
  browser: Browser,
  url: string,
  options: { emulated: boolean; shaper?: LinkShaper; context?: BrowserContext },
) {
  const context =
    options.context ?? (await browser.newContext({ viewport: { width: 1440, height: 900 } }));
  try {
    const results: SlowLinkResult[] = [];
    // A warm visit needs the cold one before it, measured or not.
    if (!caches.includes("cold") && caches.includes("warm"))
      await navigate(context, url, "cold", options);
    for (const cache of caches) results.push(await navigate(context, url, cache, options));
    return results;
  } finally {
    await context.close();
  }
}

const results =
  target === "preview"
    ? await withPerfApp(async ({ browser, origin }) =>
        run(browser, `${origin}/t/thread-soak?rate=20`, { emulated: true }),
      )
    : await withDaemonApp(async ({ origin: upstream, pair, threadPath, browserArgs }) => {
        const shaper = await startLinkShaper({ target: upstream, profile });
        const browser = await chromium.launch({ args: browserArgs });
        try {
          const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
          await pair(context, shaper.address);
          return await run(browser, `https://${shaper.address}${threadPath}`, {
            emulated: false,
            shaper,
            context,
          });
        } finally {
          await browser.close();
          await shaper.close();
        }
      });
for (const result of results) reportSlowLink(result);
process.stdout.write(
  `${JSON.stringify({ bench: "web-slow-link", target, profile: profile.name, results })}\n`,
);
