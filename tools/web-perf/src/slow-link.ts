import type { Browser } from "@playwright/test";
import { z } from "zod";
import { loadChain, type LoadRequest } from "./load-chain.ts";
import { open, withPerfApp } from "./perf-app.ts";

/*
 * Navigation over a slow link (ADR 0056): a remote device opening a thread through a tunnel
 * or a phone network, with a cold cache. Chromium's network emulation adds the profile's
 * latency to every request and caps its throughput, so serialized requests and late chunk
 * discovery cost what they would on such a link. Report only, no budget: it says how many
 * requests and sequential round trips the first screen waits on and when the thread's
 * content is there, for comparing one boot order with another.
 */

/** About a phone network or a relayed tunnel: 300 ms round trip, 1.6 Mbit/s down. */
export const slowLink = {
  latencyMs: 300,
  downloadBytesPerSecond: 1_600_000 / 8,
  uploadBytesPerSecond: 750_000 / 8,
};

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
  transcriptMs: number;
  sidebarMs: number | null;
  requests: number;
  kilobytes: number;
  roundTrips: number;
  path: string[];
  /** Requests before first content by type and initiator, most first. */
  kinds: [string, number][];
}

async function measureSlowLink(browser: Browser, origin: string): Promise<SlowLinkResult> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    await page.addInitScript(markFirstContent);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: slowLink.latencyMs,
      downloadThroughput: slowLink.downloadBytesPerSecond,
      uploadThroughput: slowLink.uploadBytesPerSecond,
    });
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
    await open(page, `${origin}/t/thread-soak?rate=20`);
    await page
      .getByRole("feed", { name: "Transcript" })
      .getByRole("article")
      .first()
      .waitFor({ timeout: 60_000 });
    await page.waitForFunction(
      () =>
        (globalThis as { aceFirstContent?: { transcript: unknown } }).aceFirstContent?.transcript !=
        null,
    );
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
      kinds: [...kinds].toSorted((a, b) => b[1] - a[1]).slice(0, 12),
      transcriptMs,
      sidebarMs: marks.sidebar,
      requests: chain.requests,
      kilobytes: chain.bytes / 1024,
      roundTrips: chain.roundTrips,
      path: chain.path,
    };
  } finally {
    await context.close();
  }
}

function mapInitiator(initiator: z.infer<typeof Initiator>): string | undefined {
  const url = initiatorUrl(initiator);
  return url === undefined || url.startsWith("about:") ? undefined : pathOf(url);
}

const line = (label: string, value: string) =>
  process.stdout.write(`  ${label.padEnd(54)} ${value}\n`);

function reportSlowLink(result: SlowLinkResult): void {
  process.stdout.write(
    `slow link (${slowLink.latencyMs} ms round trip, ${(slowLink.downloadBytesPerSecond * 8) / 1e6} Mbit/s down), cold cache:\n`,
  );
  line("first thread content (ms)", result.transcriptMs.toFixed(0));
  line("first sidebar row (ms)", result.sidebarMs === null ? "none" : result.sidebarMs.toFixed(0));
  line("requests before first content", String(result.requests));
  line("transferred before first content (KB)", result.kilobytes.toFixed(0));
  line("sequential round trips before first content", String(result.roundTrips));
  line("deepest chain", result.path.join(" → "));
  for (const [kind, count] of result.kinds) line(`  ${kind}`, String(count));
}

await withPerfApp(async ({ browser, origin }) => {
  reportSlowLink(await measureSlowLink(browser, origin));
});
