import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { BrowserService, connectBrowser, detectChromium } from "../src/index.ts";
import { decodeStreamMessage, StreamAssembler } from "../src/stream.ts";

/*
 * Where a live view's frames go on this machine, report only. For several Chrome graphics
 * settings it measures the page's own frame rate (unwatched, the ceiling for any video) at
 * device scale 1 and 2, and WebCodecs encode throughput at the encode sizes ace uses. Run by the
 * Windows workflow next to `video-link.ts` to tell renderer limits from encoder limits.
 */

const executable = process.env.ACE_CHROMIUM_PATH ?? (await detectChromium());
if (!executable) {
  console.log(JSON.stringify({ skipped: "no Chrome or Chromium installed" }));
  process.exit(0);
}

/** The PE machine field: which architecture the browser binary runs as. */
async function binaryArch(path: string): Promise<string> {
  if (process.platform !== "win32") return "n/a";
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(4096);
    await file.read(header, 0, header.length, 0);
    const machine = header.readUInt16LE(header.readUInt32LE(0x3c) + 4);
    return (
      ({ 0x8664: "x64", 0xaa64: "arm64", 0x14c: "x86" } as Record<number, string>)[machine] ??
      machine.toString(16)
    );
  } finally {
    await file.close();
  }
}

const paragraphs = Array.from(
  { length: 600 },
  (_, index) =>
    `<p>${index}. Remote browser view: sharp text and smooth scrolling, 0123456789.</p>`,
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
const pageUrl = `http://127.0.0.1:${address.port}/`;

const Reply = z.object({
  id: z.number().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});

class Cdp {
  #socket: WebSocket;
  #next = 1;
  #pending = new Map<number, (reply: z.infer<typeof Reply>) => void>();
  constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      const reply = Reply.safeParse(JSON.parse(String(event.data)));
      if (!reply.success || reply.data.id === undefined) return;
      this.#pending.get(reply.data.id)?.(reply.data);
      this.#pending.delete(reply.data.id);
    });
  }
  async send(method: string, params: object = {}, sessionId?: string): Promise<unknown> {
    const id = this.#next++;
    const reply = new Promise<z.infer<typeof Reply>>((resolve) => this.#pending.set(id, resolve));
    this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    const settled = await reply;
    if (settled.error) throw new Error(`${method}: ${settled.error.message}`);
    return settled.result;
  }
}

async function evaluate(cdp: Cdp, sessionId: string, expression: string): Promise<unknown> {
  const reply = z
    .object({
      result: z.object({ value: z.unknown().optional() }),
      exceptionDetails: z.unknown().optional(),
    })
    .parse(
      await cdp.send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      ),
    );
  if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails));
  return reply.result.value;
}

const rafRate = `new Promise((resolve) => {
  let frames = 0; const start = performance.now();
  const tick = () => { frames++; performance.now() - start < 5000 ? requestAnimationFrame(tick) : resolve(Math.round(frames / ((performance.now() - start) / 10000)) / 10); };
  requestAnimationFrame(tick);
})`;

/** Frames per second one encoder sustains for a scrolling text picture, and whether it ran. */
const encodeRate = (
  codec: string,
  width: number,
  height: number,
  acceleration: string,
) => `(async () => {
  const config = { codec: ${JSON.stringify(codec)}, width: ${width}, height: ${height}, bitrate: 4_000_000, framerate: 60,
    latencyMode: "realtime", hardwareAcceleration: ${JSON.stringify(acceleration)}, ${codec.startsWith("avc1.") ? 'avc: { format: "avc" },' : ""} };
  const support = await VideoEncoder.isConfigSupported(config).catch((error) => ({ supported: false, error: String(error) }));
  if (!support.supported) return { supported: false };
  const canvas = new OffscreenCanvas(${width}, ${height});
  const context = canvas.getContext("2d");
  let out = 0; let failed;
  const encoder = new VideoEncoder({ output: () => out++, error: (error) => (failed = String(error)) });
  encoder.configure(config);
  const frames = 120; const start = performance.now();
  for (let index = 0; index < frames; index++) {
    context.fillStyle = "#fff"; context.fillRect(0, 0, ${width}, ${height});
    context.fillStyle = "#1d1d1f"; context.font = "32px system-ui";
    for (let line = 0; line < ${Math.ceil(height / 40)}; line++) context.fillText(index + " The quick brown fox jumps over the lazy dog 0123456789", 20, line * 40 - (index * 8) % 40 + 40);
    const frame = new VideoFrame(canvas, { timestamp: index * 16667 });
    while (encoder.encodeQueueSize > 2) await new Promise((resolve) => setTimeout(resolve, 0));
    encoder.encode(frame, { keyFrame: index === 0 });
    frame.close();
  }
  await encoder.flush().catch((error) => (failed = String(error)));
  const seconds = (performance.now() - start) / 1000;
  encoder.close();
  return { supported: true, fps: Math.round(out / seconds), out, failed };
})()`;

async function launch(args: readonly string[], scale: number) {
  const profile = await mkdtemp(join(tmpdir(), "ace-video-profile-"));
  const child = spawn(
    executable as string,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--disable-audio-output",
      "--window-size=1280,800",
      ...(scale === 1 ? [] : [`--force-device-scale-factor=${scale}`]),
      ...args,
      "about:blank",
    ],
    { stdio: "ignore", windowsHide: true },
  );
  let port: string | undefined;
  for (let attempt = 0; attempt < 300 && !port; attempt++) {
    port = await readFile(join(profile, "DevToolsActivePort"), "utf8").then(
      (text) => text.split("\n")[0],
      () => undefined,
    );
    if (!port) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!port) throw new Error("Chrome did not start");
  const version = z
    .object({ webSocketDebuggerUrl: z.string() })
    .parse(await (await fetch(`http://127.0.0.1:${port}/json/version`)).json());
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const cdp = new Cdp(socket);
  const close = async () => {
    await cdp.send("Browser.close").catch(() => {});
    socket.close();
    await new Promise((resolve) =>
      child.exitCode === null ? child.once("exit", resolve) : resolve(undefined),
    );
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  };
  return { cdp, close };
}

async function page(cdp: Cdp, url: string): Promise<string> {
  const { targetId } = z
    .object({ targetId: z.string() })
    .parse(await cdp.send("Target.createTarget", { url, newWindow: true }));
  const { sessionId } = z
    .object({ sessionId: z.string() })
    .parse(await cdp.send("Target.attachToTarget", { targetId, flatten: true }));
  // Like ace's tabs: a window of its own, sized as a viewer's pane, loaded before measuring.
  const { windowId } = z
    .object({ windowId: z.number() })
    .parse(await cdp.send("Browser.getWindowForTarget", { targetId }));
  await cdp.send("Browser.setWindowBounds", { windowId, bounds: { width: 1280, height: 800 } });
  for (let attempt = 0; attempt < 100; attempt++) {
    const ready = await evaluate(cdp, sessionId, "location.href + ' ' + document.readyState").catch(
      () => "",
    );
    if (ready === `${url} complete`) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return sessionId;
}

const variants: { name: string; args: string[] }[] = [
  { name: "default", args: [] },
  { name: "angle-d3d11", args: ["--use-angle=d3d11"] },
  { name: "angle-warp", args: ["--use-angle=d3d11-warp"] },
  { name: "swiftshader", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
  { name: "disable-gpu", args: ["--disable-gpu"] },
  { name: "no-gpu-raster", args: ["--disable-gpu-rasterization"] },
  { name: "warp-gpu-raster", args: ["--use-angle=d3d11-warp", "--enable-gpu-rasterization"] },
];

const pipelineVariants = [
  { name: "default", args: [], scale: 2 },
  { name: "default", args: [], scale: 1.5 },
  { name: "default", args: [], scale: 1 },
  { name: "angle-warp", args: ["--use-angle=d3d11-warp"], scale: 2 },
];

const report: Record<string, unknown> = {
  executable,
  browserArch: await binaryArch(executable),
  nodeArch: process.arch,
};
try {
  for (const variant of variants) {
    for (const scale of [2, 1.5, 1]) {
      const name = `${variant.name}@${scale}x`;
      try {
        const browser = await launch(variant.args, scale);
        try {
          const info = z
            .object({
              gpu: z.object({
                devices: z.array(z.object({ vendorString: z.string(), deviceString: z.string() })),
                featureStatus: z.record(z.string(), z.unknown()).optional(),
              }),
            })
            .safeParse(await browser.cdp.send("SystemInfo.getInfo"));
          const session = await page(browser.cdp, pageUrl);
          const fps = await evaluate(browser.cdp, session, rafRate);
          const entry: Record<string, unknown> = { pageFps: fps };
          if (info.success) {
            entry.gpu = info.data.gpu.devices.map((device) => device.deviceString).join(" | ");
            const status = info.data.gpu.featureStatus ?? {};
            entry.features = Object.fromEntries(
              ["gpu_compositing", "rasterization", "video_encode", "webgl"].map((key) => [
                key,
                status[key],
              ]),
            );
          }
          if (scale === 2 && variant.name === "default") {
            const encodes: Record<string, unknown> = {};
            for (const codec of ["avc1.640033", "hvc1.1.6.L153.B0", "vp09.00.10.08", "vp8"])
              for (const [width, height] of [
                [2560, 1600],
                [1280, 800],
              ] as const)
                for (const acceleration of ["prefer-hardware", "prefer-software"])
                  encodes[`${codec} ${width}x${height} ${acceleration.slice(7)}`] = await evaluate(
                    browser.cdp,
                    session,
                    encodeRate(codec, width, height, acceleration),
                  ).catch((error: unknown) => String(error).slice(0, 200));
            entry.encodes = encodes;
          }
          report[name] = entry;
        } finally {
          await browser.close();
        }
      } catch (error) {
        report[name] = { error: String(error).slice(0, 300) };
      }
      console.log(JSON.stringify({ [name]: report[name] }));
    }
  }
  // The real pipeline (tab capture, encoder, socket) with an instant link: what each setting
  // delivers, next to the page's own rate while it streams.
  for (const variant of pipelineVariants) {
    const name = `pipeline ${variant.name}@${variant.scale}x`;
    report[name] = await pipeline(variant.args, variant.scale).catch((error: unknown) => ({
      error: String(error).slice(0, 300),
    }));
    console.log(JSON.stringify({ [name]: report[name] }));
  }
} finally {
  server.closeAllConnections();
  server.close();
}
console.log(JSON.stringify(report));

async function pipeline(args: string[], scale: number) {
  const home = await mkdtemp(join(tmpdir(), "ace-video-profile-"));
  const service = new BrowserService({
    dataDir: home,
    executablePath: executable as string,
    chrome: { args, deviceScaleFactor: scale },
  });
  const shown: number[] = [];
  const sizes = new Set<string>();
  const assembler = new StreamAssembler();
  let counting = false;
  const bridge = connectBrowser(service, {
    connectionId: "profile",
    authorize: () => true,
    send: () => true,
    sendStream: (pieces) => {
      for (const piece of pieces) {
        const envelope = assembler.push(piece);
        const message = envelope && decodeStreamMessage(envelope);
        if (!message || message.kind !== "browser.video") continue;
        if (counting) {
          shown.push(performance.now());
          sizes.add(
            `${message.chunk.codec} ${message.chunk.codedWidth}x${message.chunk.codedHeight}`,
          );
        }
        void bridge.handle({
          type: "browser.ack",
          threadId: "profile",
          requestId: "ack",
          sequence: message.chunk.sequence,
          video: true,
        });
      }
      return true;
    },
  });
  try {
    await service.open({ threadId: "profile", workspaceId: "profile", profile: "persistent" });
    await service.execute("profile", { action: "navigate", url: pageUrl });
    await service.execute("profile", { action: "resize", width: 1280, height: 800 });
    const unwatched = await service.execute("profile", { action: "evaluate", expression: rafRate });
    await bridge.handle({
      type: "browser.subscribe",
      threadId: "profile",
      requestId: "subscribe",
      binaryFrames: true,
      viewport: { width: 1280, height: 800, devicePixelRatio: 2 },
      video: { codecs: ["hvc1.1.6.L153.B0", "avc1.640033", "avc1.42E033", "vp8"] },
    });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    counting = true;
    const started = performance.now();
    const streaming = await service.execute("profile", { action: "evaluate", expression: rafRate });
    counting = false;
    return {
      unwatchedPageFps: unwatched,
      streamingPageFps: streaming,
      deliveredFps: Math.round((shown.length / ((performance.now() - started) / 1000)) * 10) / 10,
      encodes: [...sizes],
    };
  } finally {
    bridge.close();
    await service.close();
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }
}
