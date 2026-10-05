import { z } from "zod";
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { startDaemon, readConfig } from "../../../apps/daemon/src/index.ts";

const helperCpu = (home: string) => {
  const ps = execFileSync("/bin/ps", ["-axo", "pid,ppid,time,comm"], { encoding: "utf8" });
  const line = ps
    .split("\n")
    .find(
      (l) =>
        l.includes(home + "/screen-helper/") &&
        l.includes("AceScreenHelper.app/Contents/MacOS/ace-screen-helper"),
    );
  const time = line?.trim().split(/\s+/)[2];
  if (!time) return null;
  const parts = time.split(":").map(Number);
  return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
};

const percentile = (values: number[], p: number) =>
  values.length ? values.toSorted((a, b) => a - b)[Math.floor((values.length - 1) * p)] : null;

// Requires an explicitly owned simulator; the wrapper creates/deletes it.
const home = process.env["ACE_HOME"];
const udid = process.env["ACE_PERF_UDID"];
if (!home?.startsWith("/tmp/ace-device-perf.") || !udid)
  throw new Error("Run the device perf wrapper");
await mkdir(home, { recursive: true });
const root = new URL("../../../", import.meta.url).pathname;
execFileSync(
  "bun",
  [
    "build",
    root + "tools/web-perf/device/client.ts",
    "--outfile",
    home + "/client.js",
    "--target",
    "browser",
  ],
  { cwd: root, stdio: "ignore" },
);
const http = createServer(async (req, res) => {
  if (req.url === "/client.js") {
    res.setHeader("Content-Type", "text/javascript");
    res.end(await readFile(home + "/client.js"));
  } else {
    res.setHeader("Content-Type", "text/html");
    res.end('<html><body><script src="/client.js" type="module"></script></body></html>');
  }
});
await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
const address = http.address();
if (!address || typeof address === "string") throw new Error("Missing HTTP");
const origin = `http://127.0.0.1:${address.port}`;
const daemon = await startDaemon({
  config: readConfig({
    ...process.env,
    ACE_PORT: "0",
    ACE_WEB_ORIGINS: origin,
    ACE_LOG_LEVEL: "silent",
  }),
  engine: {
    adapterDiscovery: async () => ({
      claude: { installed: false, auth: "unknown", loginHint: "" },
      codex: { installed: false, auth: "unknown", loginHint: "" },
      cursor: { installed: false, auth: "unknown", loginHint: "" },
      opencode: { installed: false, auth: "unknown", loginHint: "" },
    }),
  },
  modelInstances: [],
});
const browser = await chromium.launch({
  headless: true,
  args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding"],
});
try {
  const page = await browser.newPage();
  await page.addInitScript((config) => Reflect.set(globalThis, "probeConfig", config), {
    url: daemon.url,
    token: (await readFile(daemon.tokenPath, "utf8")).trim(),
    deviceId: "ios:" + udid,
    fps: Number(process.env["ACE_PERF_FPS"] ?? 60),
    baseline: process.env["ACE_PERF_BASELINE"] === "1",
  });
  page.on("pageerror", (e) => console.error(e));
  await page.goto(origin);
  await page.waitForFunction(() => Reflect.get(globalThis, "probeReady"));
  await page.evaluate(() => Reflect.get(globalThis, "probeStart")());
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    const r = Reflect.get(globalThis, "probeRecord");
    r.latencies = [];
    r.capture = [];
    r.input = [];
    r.frames = 0;
    r.bytes = 0;
    r.codecs = { jpeg: 0, h264: 0 };
  });
  const usage = process.cpuUsage();
  const start = Date.now();
  const cdp = await browser.newBrowserCDPSession();
  const cpus = async () => {
    const info = await cdp.send("SystemInfo.getProcessInfo");
    return info.processInfo.filter((p) => p.type === "renderer").reduce((n, p) => n + p.cpuTime, 0);
  };
  const cpuBefore = await cpus();
  const helperBefore = helperCpu(home);
  for (let i = 0; i < 16; i++) {
    await page.evaluate(() => Reflect.get(globalThis, "probeTap")());
    await page.waitForTimeout(650);
  }
  const elapsed = Date.now() - start;
  const cpu = process.cpuUsage(usage);
  const helperAfter = helperCpu(home);
  const cpuAfter = await cpus();
  const record = z
    .object({
      latencies: z.array(z.number()),
      capture: z.array(z.number()),
      input: z.array(z.number()),
      dispatch: z.array(z.number()),
      frames: z.number(),
      bytes: z.number(),
      errors: z.array(z.string()),
      codecs: z.object({ jpeg: z.number(), h264: z.number() }),
    })
    .parse(await page.evaluate(() => Reflect.get(globalThis, "probeRecord")));
  // Freeze samples before stopping capture; teardown must not inflate measured CPU/FPS.
  await page.evaluate(() => Reflect.get(globalThis, "probeStop")());
  await page.screenshot({ path: home + "/display.png" });
  const result = {
    codecs: record.codecs,
    resolution: await page.locator("canvas").evaluate((canvas) => {
      if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Canvas missing");
      return { width: canvas.width, height: canvas.height };
    }),
    fps: (record.frames * 1000) / elapsed,
    mbps: (record.bytes * 8) / elapsed / 1000,
    captureToDisplayMs: {
      p50: percentile(record.capture, 0.5),
      p95: percentile(record.capture, 0.95),
      samples: record.capture.length,
    },
    sourcePixelToDisplayMs: {
      p50: percentile(record.latencies, 0.5),
      p95: percentile(record.latencies, 0.95),
      samples: record.latencies.length,
    },
    inputDispatchMs: {
      p50: percentile(record.dispatch, 0.5),
      p95: percentile(record.dispatch, 0.95),
    },
    inputToPixelMs: {
      p50: percentile(record.input, 0.5),
      p95: percentile(record.input, 0.95),
      samples: record.input.length,
    },
    cpuPercent: {
      helper:
        helperBefore !== null && helperAfter !== null
          ? ((helperAfter - helperBefore) * 100000) / elapsed
          : null,
      daemon: (cpu.user + cpu.system) / elapsed / 10,
      renderer: ((cpuAfter - cpuBefore) * 100000) / elapsed,
    },
    errors: record.errors,
  };
  console.log(JSON.stringify(result, null, 2));
  if (
    process.env["ACE_PERF_ASSERT"] === "1" &&
    (result.fps < 30 ||
      (result.captureToDisplayMs.p50 ?? Infinity) >= 80 ||
      (result.inputToPixelMs.p50 ?? Infinity) >= 120)
  )
    throw new Error("Local device performance target missed");
  if (!record.latencies.length || !record.input.length)
    throw new Error("Pixel clock/input detector did not observe the app");
} finally {
  await browser.close();
  await daemon.close();
  await new Promise<void>((resolve, reject) => http.close((e) => (e ? reject(e) : resolve())));
}
