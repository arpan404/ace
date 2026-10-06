import { createServer } from "node:http";
import { once } from "node:events";
import { chromium } from "playwright-core";
import { detectChromium } from "../src/discovery.ts";
import { LiveCapture } from "../src/live.ts";
import { z } from "zod";
import { loadavg } from "node:os";

// Own ephemeral context, local content, and a viewer that decodes every JPEG before ack.
const executablePath = await detectChromium();
if (!executablePath) throw new Error("No test Chromium");
const server = createServer((_request, response) =>
  response.end(`<!doctype html><style>
body{margin:0;background:white}#marker{width:100px;height:100px;background:blue}
#motion{height:200px;width:500px;background:linear-gradient(90deg,red,blue);animation:move .8s infinite alternate}
@keyframes move{to{transform:translateX(600px)}}
</style><div id=marker></div><div id=motion></div><button onclick="marker.style.background='red'">Change</button>`),
);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("No local server");
const dpr = Number(process.env.ACE_BENCH_DPR ?? 2);
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: dpr === 2 ? ["--force-device-scale-factor=2"] : [],
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: dpr,
});
const page = await context.newPage();
const viewer = await context.newPage();
const cdp = await context.newCDPSession(page);
const live = new LiveCapture(
  cdp,
  () => performance.now(),
  () => {},
);
const loadAtStart = loadavg()[0];
let count = 0,
  bytes = 0;
let dimensions = "";
let pending: Promise<void> | undefined;
let changed: (() => void) | undefined;
let blueSeen: (() => void) | undefined;
try {
  if (dpr === 2) {
    const target = z
      .object({ windowId: z.number() })
      .parse(await cdp.send("Browser.getWindowForTarget"));
    await cdp.send("Browser.setContentsSize", {
      windowId: target.windowId,
      width: 1280,
      height: 720,
    });
  }
  await page.goto(`http://127.0.0.1:${address.port}`);
  await viewer.setContent("<canvas></canvas>");
  await page.bringToFront();
  await live.start();
  const stop = live.fanout.subscribe("bench", {
    send(frame) {
      pending = viewer
        .evaluate(
          `(async (data) => {
        const img = new Image(); img.src = 'data:image/jpeg;base64,' + data;
        await img.decode();
        const canvas = document.querySelector('canvas');
        canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
        const draw = canvas.getContext('2d'); draw.drawImage(img, 0, 0);
        const pixel = draw.getImageData(10, 10, 1, 1).data;
        return { width: img.naturalWidth, height: img.naturalHeight, red: pixel[0] > 200 && pixel[2] < 50, blue: pixel[2] > 200 && pixel[0] < 50 };
      })(${JSON.stringify(frame.data)})`,
        )
        .then((raw: unknown) => {
          const result = z
            .object({ width: z.number(), height: z.number(), red: z.boolean(), blue: z.boolean() })
            .parse(raw);
          dimensions = `${result.width}x${result.height}`;
          count++;
          bytes += Buffer.from(frame.data, "base64").length;
          if (result.red) changed?.();
          if (result.blue) blueSeen?.();
          live.fanout.acknowledge("bench", frame.sequence);
        });
      return true;
    },
  });
  const configure: unknown = Reflect.get(live.fanout, "configure");
  if (typeof configure === "function")
    Reflect.apply(configure, live.fanout, [
      "bench",
      {
        viewport: { width: 1280, height: 720, devicePixelRatio: 2 },
        local: true,
      },
    ]);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  count = 0;
  bytes = 0;
  const start = performance.now();
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const fps = (count * 1000) / (performance.now() - start);
  const meanBytes = Math.round(bytes / count);
  const latency: number[] = [];
  for (let i = 0; i < 8; i++) {
    const blue = Promise.withResolvers<void>();
    blueSeen = blue.resolve;
    await page.evaluate("document.getElementById('marker').style.background='blue'");
    await Promise.race([
      blue.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("No blue reset pixel")), 5000)),
    ]);
    blueSeen = undefined;
    const seen = Promise.withResolvers<void>();
    changed = seen.resolve;
    const inputAt = performance.now();
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 30,
      y: 310,
      button: "left",
      clickCount: 1,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: 30,
      y: 310,
      button: "left",
      clickCount: 1,
    });
    await Promise.race([
      seen.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("No changed pixel")), 3000)),
    ]);
    latency.push(performance.now() - inputAt);
    changed = undefined;
  }
  latency.sort((a, b) => a - b);
  console.log(
    JSON.stringify(
      z
        .object({
          loadAtStart: z.number(),
          dimensions: z.string(),
          fps: z.number(),
          meanJpegBytes: z.number(),
          inputToDecodedPixelMedianMs: z.number(),
        })
        .parse({
          loadAtStart,
          dimensions,
          fps: Number(fps.toFixed(1)),
          meanJpegBytes: meanBytes,
          inputToDecodedPixelMedianMs: Number((latency[4] ?? 0).toFixed(1)),
        }),
    ),
  );
  stop();
  await pending;
} finally {
  live.fanout.clear();
  await pending?.catch(() => {});
  await live.close();
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
