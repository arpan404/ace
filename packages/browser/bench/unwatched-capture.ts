/**
 * What a browser page costs while nobody watches it, while one viewer does, and after that
 * viewer leaves. ace's own headless Chrome shows a local page with a CSS animation (any
 * spinner); the measurement is CPU time of every Chrome process for this profile, of this
 * process, and the screencast frames Chrome encoded.
 *
 *   node packages/browser/bench/unwatched-capture.ts [--seconds=20] [--output=result.json]
 *
 * Run the same script in each checkout. It opens no network connections beyond loopback.
 */
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { BrowserOpen } from "@ace/protocol";
import { detectChromium } from "../src/discovery.ts";
import { ChromeBackend } from "../src/headless.ts";
import { LiveCapture } from "../src/live.ts";
import { chromeDefaults } from "../src/owned-backend.ts";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value = ""] = arg.replace(/^--/, "").split("=");
    return [key ?? "", value];
  }),
);
const seconds = Number(args.get("seconds") ?? 20);
const output = args.get("output") ?? "";

const executablePath = await detectChromium();
if (!executablePath) throw new Error("No Chromium for the benchmark");
const server = createServer((_request, response) =>
  response.end(`<!doctype html><style>
body{margin:0;background:white;font:16px system-ui}
.spinner{width:48px;height:48px;margin:40px;border:6px solid #ddd;border-top-color:#36f;border-radius:50%;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
</style><p>Working…</p><div class=spinner></div>`),
);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("No local server");

const home = await mkdtemp(join(tmpdir(), "ace-unwatched-"));
const profileDir = join(home, "profile");
const defaults = chromeDefaults(process.platform);
const backend = new ChromeBackend({
  executable: async () => executablePath,
  stagingDir: (profile) => `${profile}-downloads`,
  platform: process.platform,
  launch: defaults.launch,
  cleanup: defaults.cleanup,
});
const lifetime = new AbortController();
const session = await backend.open({
  options: BrowserOpen.parse({ threadId: "bench", workspaceId: "bench", profile: "ephemeral" }),
  profileDir,
  signal: lifetime.signal,
  allowed: async () => true,
  navigation() {},
  log() {},
  lost() {},
});
await session.cdp.send("Page.navigate", { url: `http://127.0.0.1:${address.port}/` });
await sleep(1000);

let frames = 0;
const live = new LiveCapture(
  session.cdp,
  () => performance.now(),
  () => {
    frames++;
  },
);
await live.start();

/** CPU seconds of every Chrome process started for this benchmark's profile. */
function chromeCpuSeconds(): number {
  const table = execFileSync("ps", ["-A", "-o", "time=,command="], { encoding: "utf8" });
  let total = 0;
  for (const line of table.split("\n")) {
    if (!line.includes(profileDir)) continue;
    const time = line.trim().split(/\s+/)[0] ?? "0";
    // macOS and procps: [[dd-]hh:]mm:ss[.cc]
    const [days, clock] = time.includes("-") ? time.split("-") : ["0", time];
    const parts = (clock ?? "0").split(":").map(Number);
    let value = 0;
    for (const part of parts) value = value * 60 + part;
    total += Number(days) * 86_400 + value;
  }
  return total;
}
async function measure(phase: string) {
  await sleep(2000);
  const chrome = chromeCpuSeconds();
  const own = process.cpuUsage();
  const before = frames;
  const load = loadavg()[0];
  await sleep(seconds * 1000);
  const ownUsed = process.cpuUsage(own);
  return {
    phase,
    seconds,
    chromeCpuPercent: +(((chromeCpuSeconds() - chrome) / seconds) * 100).toFixed(1),
    daemonCpuPercent: +(((ownUsed.user + ownUsed.system) / 1e6 / seconds) * 100).toFixed(1),
    framesPerSecond: +((frames - before) / seconds).toFixed(1),
    loadAverage: +(load ?? 0).toFixed(1),
  };
}

const results = [await measure("nobody watching")];
const viewer = "viewer";
const leave = live.subscribe(
  viewer,
  {
    send(frame) {
      queueMicrotask(() => live.fanout.acknowledge(viewer, frame.sequence));
      return true;
    },
  },
  { viewport: { width: 1280, height: 800, devicePixelRatio: 2 }, local: true },
);
results.push(await measure("one viewer watching"));
leave();
await sleep(6000);
results.push(await measure("after the viewer left"));

await live.close();
lifetime.abort();
await backend.close().catch(() => {});
server.close();
await rm(home, { recursive: true, force: true }).catch(() => {});
const json = JSON.stringify({ chromium: executablePath, results }, null, 2);
console.log(json);
if (output) await writeFile(output, json);
process.exit(0);
