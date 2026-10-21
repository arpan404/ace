import { spawnSync } from "node:child_process";
import { decodeStreamMessage, encodeBrowserVideo, StreamAssembler } from "@ace/browser/stream";
import { facts, type FakeDaemon } from "@ace/fake-daemon";
import type { Fact } from "@ace/core";
import { ThreadId } from "@ace/protocol";
import { z } from "zod";

/*
 * The browser in the iOS spike fixture: a thread whose agent works in a checkout page, with a
 * second tab, console lines and a download, and HTTP controls that make the page ask for things
 * (a dialog, a sign-in, a file). The fake daemon draws its pages as SVG, which the phone's
 * H.264 decoder can't play, so each picture it sends is swapped for a real H.264 keyframe of a
 * drawn page (encoded once per size with the Mac's ffmpeg). No browser runs anywhere.
 */

export const browserThread = ThreadId.parse("ios-browser");
const page = "https://shop.example/checkout";

type Details = (branch: string) => Record<string, unknown>;

const mcp = (item: string, name: string, args: Record<string, unknown>): Fact =>
  facts.tool("root", item, {
    kind: "mcp",
    title: name,
    detail: { kind: "mcp", server: "ace", tool: name, arguments: args },
  });

/** The thread, its browser and the agent working in it. */
export function seedBrowser(daemon: FakeDaemon, details: Details): void {
  daemon.createThread({
    hasSentMessage: true,
    id: browserThread,
    workspaceId: "ace",
    title: "Check the checkout flow",
    provider: "claude",
    details: details("fix/checkout"),
  });
  daemon.apply(browserThread, [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Check the checkout flow on staging and fix what breaks."),
    mcp("open", "browser_open", { url: page }),
    facts.toolDone("root", "open"),
    facts.message(
      "root",
      "progress",
      "assistant",
      "The checkout page loads. Paying with the saved card fails with a 402 from the payments API; checking the request now.",
      false,
    ),
  ]);
  const browser = daemon.browser;
  browser.drive(browserThread, { url: page });
  browser.pageIdentity(browserThread, { title: "Checkout · Shop" });
  const first = browser.view(browserThread)?.activeTabId;
  const cart = browser.personOpen(browserThread, "https://shop.example/cart");
  browser.pageIdentity(browserThread, { title: "Your cart · Shop" }, cart);
  if (first) browser.tabSelect(browserThread, first);
  const view = daemon.snapshot({ kind: "thread", threadId: browserThread });
  const agentId = view?.kind === "thread" ? Object.keys(view.agents)[0] : undefined;
  browser.agentWorks(browserThread, {
    ...(agentId ? { agentId } : {}),
    pointer: { x: 200, y: 470 },
  });
  const log = (kind: "console" | "network", type: string, text: string, extra = {}) =>
    browser.logs.add(browserThread, {
      kind,
      type,
      text,
      ...(first ? { tabId: first } : {}),
      ...extra,
    });
  log("console", "log", "Checkout mounted in 182 ms");
  log("console", "warning", "Image without width or height: /img/headphones.webp");
  log("console", "error", "POST https://api.shop.example/payments 402 (Payment Required)");
  log("console", "error", "Uncaught (in promise) PaymentError: card_declined");
  log("network", "response", "GET /checkout", {
    url: page,
    status: 200,
    method: "GET",
    bytes: 48_200,
    durationMs: 212,
  });
  log("network", "response", "POST /payments", {
    url: "https://api.shop.example/payments",
    status: 402,
    method: "POST",
    bytes: 320,
    durationMs: 640,
  });
  browser.downloadAdd(browserThread, {
    downloadId: "receipt",
    tabId: first ?? "tab",
    filename: "receipt-2291.pdf",
    bytes: 84_000,
    mimeType: "application/pdf",
    flags: [],
    state: "complete",
    path: "/fixture/receipt-2291.pdf",
  });
}

const Control = z.object({
  action: z.enum(["dialog", "prompt", "signin", "chooser", "agent", "idle", "fail"]),
});

/** `POST /browser {action}`: the page asks for something, or the agent comes and goes. */
export async function browserControl(
  daemon: FakeDaemon,
  request: Request,
): Promise<Response | undefined> {
  if (new URL(request.url).pathname !== "/browser" || request.method !== "POST") return undefined;
  const { action } = Control.parse(await request.json());
  const browser = daemon.browser;
  const tabId = browser.view(browserThread)?.activeTabId ?? "";
  if (action === "dialog")
    browser.dialogOpen(browserThread, {
      dialogId: `d${Date.now()}`,
      tabId,
      type: "confirm",
      message: "Leave the saved card on file?",
    });
  else if (action === "prompt")
    browser.dialogOpen(browserThread, {
      dialogId: `p${Date.now()}`,
      tabId,
      type: "prompt",
      message: "Gift message",
      defaultPrompt: "Happy birthday!",
    });
  else if (action === "signin") browser.signInAsk(browserThread, tabId, "Staging");
  else if (action === "chooser") browser.fileChooserOpen(browserThread, tabId, false);
  else if (action === "agent") browser.agentWorks(browserThread, { pointer: { x: 120, y: 300 } });
  else if (action === "idle") browser.agentIdle(browserThread);
  else browser.loadFailed(browserThread, "net::ERR_CONNECTION_REFUSED");
  return Response.json({ ok: true });
}

/**
 * A person's screenshot of the fixture page, answered here since the fake's screenshot is an
 * SVG: true when `text` was that request and is answered.
 */
export function answerScreenshot(
  text: string,
  send: (text: string) => void,
  daemon: FakeDaemon,
): boolean {
  if (!text.includes('"browser.execute"') || !text.includes('"screenshot"')) return false;
  const message = z
    .object({
      type: z.literal("browser.execute"),
      requestId: z.string(),
      threadId: z.string(),
      command: z.object({ action: z.literal("screenshot") }),
    })
    .safeParse(JSON.parse(text));
  if (!message.success) return false;
  const frame = daemon.browser.frame(message.data.threadId);
  const png = drawPage(
    frame?.width ?? 402,
    frame?.height ?? 640,
    "png",
    title(daemon, message.data.threadId),
  );
  send(
    JSON.stringify({
      type: "browser.result",
      requestId: message.data.requestId,
      ok: true,
      result: { path: "/fixture/screenshot.png", data: png.toString("base64") },
    }),
  );
  return true;
}

/** The binary path to one socket: video chunks become real H.264; anything else passes. */
export function realVideo(
  daemon: FakeDaemon,
  send: (bytes: Uint8Array) => void,
): (bytes: Uint8Array) => void {
  const assembler = new StreamAssembler();
  let streams = 0;
  return (bytes) => {
    const envelope = assembler.push(bytes);
    if (!envelope) return;
    const message = decodeStreamMessage(envelope);
    if (message?.kind !== "browser.video") {
      send(bytes);
      return;
    }
    const { threadId, chunk } = message;
    const video = encoded(chunk.width, chunk.height, title(daemon, threadId));
    for (const piece of encodeBrowserVideo(
      ++streams,
      threadId,
      {
        ...chunk,
        codedWidth: video.width,
        codedHeight: video.height,
        key: true,
        description: video.description,
      },
      video.sample,
    ))
      send(piece);
  };
}

function title(daemon: FakeDaemon, threadId: string): string {
  const tab = daemon.browser.tab(threadId);
  return tab?.url.includes("cart") ? "Your cart" : "Checkout";
}

const cache = new Map<
  string,
  { width: number; height: number; description: Uint8Array; sample: Uint8Array }
>();
/** One keyframe of the drawn page at twice its CSS size, as an avcC description and AVC sample. */
function encoded(width: number, height: number, heading: string) {
  const key = `${width}x${height}:${heading}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const annexB = drawPage(width, height, "h264", heading);
  const units = nalUnits(annexB);
  const sps = units.find((unit) => (unit[0] ?? 0) % 32 === 7);
  const pps = units.find((unit) => (unit[0] ?? 0) % 32 === 8);
  if (!sps || !pps) throw new Error("ffmpeg gave no parameter sets");
  const description = Buffer.concat([
    Buffer.from([1, sps[1] ?? 0, sps[2] ?? 0, sps[3] ?? 0, 0xff, 0xe1]),
    u16(sps.length),
    sps,
    Buffer.from([1]),
    u16(pps.length),
    pps,
  ]);
  const sample = Buffer.concat(
    // The picture's own units, length-prefixed; parameter sets travel in the description.
    units.flatMap((unit) =>
      [7, 8, 9].includes((unit[0] ?? 0) % 32) ? [] : [u32(unit.length), unit],
    ),
  );
  const value = { width: even(width * 2), height: even(height * 2), description, sample };
  cache.set(key, value);
  return value;
}

const even = (value: number) => Math.round(value / 2) * 2;
const u16 = (value: number) => Buffer.from([value >> 8, value & 255]);
const u32 = (value: number) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};
/** Annex B split at its start codes. */
function nalUnits(stream: Buffer): Buffer[] {
  const starts: { at: number; size: number }[] = [];
  for (let index = 0; index + 3 <= stream.length; index++)
    if (stream[index] === 0 && stream[index + 1] === 0 && stream[index + 2] === 1) {
      const four = index > 0 && stream[index - 1] === 0;
      starts.push({ at: four ? index - 1 : index, size: four ? 4 : 3 });
      index += 2;
    }
  return starts.map((start, index) =>
    stream.subarray(start.at + start.size, starts[index + 1]?.at ?? stream.length),
  );
}

/** ffmpeg's drawing filters, in CSS pixels drawn at 2×. */
const font = "/System/Library/Fonts/SFNS.ttf";
const text = (value: string, x: number, y: number, size: number, colour: string) =>
  `drawtext=fontfile=${font}:text='${value}':x=${x * 2}:y=${y * 2}:fontsize=${size * 2}:fontcolor=${colour}`;
const box = (x: number, y: number, bw: number, bh: number, colour: string, fill = true) =>
  `drawbox=x=${x * 2}:y=${y * 2}:w=${bw * 2}:h=${bh * 2}:color=${colour}:t=${fill ? "fill" : 2}`;

/** A shop's checkout page drawn by ffmpeg at twice `width` × `height` CSS pixels. */
function drawPage(width: number, height: number, format: "h264" | "png", heading: string): Buffer {
  const w = even(width * 2);
  const h = even(height * 2);
  const inner = width - 40;
  const filters = [
    box(0, 0, width, 52, "0x111827"),
    text("shop", 20, 15, 20, "white"),
    text("Cart  Account", width - 130, 18, 14, "0xD1D5DB"),
    text(heading, 20, 76, 28, "0x111827"),
    box(20, 124, inner, 128, "0xFFFFFF"),
    box(20, 124, inner, 128, "0xE5E7EB", false),
    text("Wireless headphones", 36, 142, 15, "0x111827"),
    text("129.00", width - 84, 142, 15, "0x111827"),
    text("USB-C cable", 36, 172, 15, "0x111827"),
    text("19.00", width - 76, 172, 15, "0x111827"),
    box(36, 202, inner - 32, 1, "0xE5E7EB"),
    text("Total", 36, 214, 16, "0x111827"),
    text("148.00", width - 86, 214, 16, "0x111827"),
    text("Email", 20, 278, 13, "0x4B5563"),
    box(20, 298, inner, 44, "0xFFFFFF"),
    box(20, 298, inner, 44, "0xD1D5DB", false),
    text("ada@example.com", 32, 311, 15, "0x111827"),
    text("Card", 20, 358, 13, "0x4B5563"),
    box(20, 378, inner, 44, "0xFFFFFF"),
    box(20, 378, inner, 44, "0xD1D5DB", false),
    text("4242 4242 4242 4242", 32, 391, 15, "0x111827"),
    box(20, 446, inner, 50, "0x2563EB"),
    text("Pay 148.00", width / 2 - 44, 461, 17, "white"),
    text("Your card was declined.", 20, 512, 14, "0xB91C1C"),
  ];
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=0xF7F7F8:s=${w}x${h}:d=1,format=yuv420p,${filters.join(",")}`,
    "-frames:v",
    "1",
    ...(format === "h264"
      ? [
          "-c:v",
          "libx264",
          "-profile:v",
          "baseline",
          "-pix_fmt",
          "yuv420p",
          "-bsf:v",
          "h264_mp4toannexb",
          "-f",
          "h264",
          "-",
        ]
      : ["-f", "image2", "-c:v", "png", "-"]),
  ];
  const result = spawnSync("ffmpeg", args, { maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr.toString()}`);
  return result.stdout;
}
