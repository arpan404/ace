/**
 * What ace's Chrome costs while nobody watches it and no agent drives it. Starts a browser
 * service under a temporary home, leaves pages in each scenario alone, and reports the CPU time
 * Chrome's processes (GPU, renderers, browser) spent over a fixed window.
 *
 *   node bench/idle-cpu.ts [windowSeconds] [settleSeconds]
 *
 * Set ACE_CHROMIUM_PATH to measure ace's pinned Chrome for Testing rather than an installed one.
 */
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserService, detectChromium } from "../src/index.ts";
import { defaultTabLifecycle } from "../src/tab-lifecycle.ts";

const windowSeconds = Number(process.argv[2] ?? 20);
const settleSeconds = Number(process.argv[3] ?? 5);
const executablePath = process.env.ACE_CHROMIUM_PATH ?? (await detectChromium());
if (!executablePath) throw new Error("No Chromium found");

const animated = `<!doctype html><html><body>
<div style="width:200px;height:200px;background:red;animation:spin 1s linear infinite"></div>
<canvas id=c width=600 height=400></canvas>
<style>@keyframes spin{to{transform:rotate(360deg)}}</style>
<script>const x=document.getElementById('c').getContext('2d');let t=0;
function f(){t++;x.fillStyle='hsl('+t%360+',80%,50%)';x.fillRect(0,0,600,400);requestAnimationFrame(f)}f()</script>
</body></html>`;
/** What a dev server's client does once its server is gone: polls it, reloading when it answers. */
const polling = `<!doctype html><html><body><p>dev page</p><script>
setInterval(()=>fetch(location.href,{cache:'no-store'}).then(()=>{}).catch(()=>{}),1000)
</script></body></html>`;

async function serve(page: string): Promise<{ url: string; server: Server }> {
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(page);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return { url: `http://127.0.0.1:${address.port}/`, server };
}

/** Seconds of CPU per process kind, for every Chrome below this process. */
function chromeCpu(): Record<string, number> {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,time=,command="], { encoding: "utf8" })
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      return match ? [{ pid: +match[1]!, ppid: +match[2]!, time: match[3]!, command: match[4]! }] : [];
    });
  const mine = new Set([process.pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of rows)
      if (!mine.has(row.pid) && mine.has(row.ppid)) {
        mine.add(row.pid);
        grew = true;
      }
  }
  const totals: Record<string, number> = {};
  for (const row of rows) {
    if (!mine.has(row.pid) || row.pid === process.pid || !/Chrom/.test(row.command)) continue;
    const kind = /--type=(\S+)/.exec(row.command)?.[1] ?? "browser";
    const parts = row.time.split(":").map(Number);
    const seconds = parts.reduce((total, part) => total * 60 + part, 0);
    totals[kind] = (totals[kind] ?? 0) + seconds;
  }
  return totals;
}

async function measure(name: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, settleSeconds * 1000));
  const before = chromeCpu();
  await new Promise((resolve) => setTimeout(resolve, windowSeconds * 1000));
  const after = chromeCpu();
  const spent: Record<string, string> = {};
  for (const kind of Object.keys(after))
    spent[kind] = ((after[kind]! - (before[kind] ?? 0)) / windowSeconds).toFixed(3);
  console.log(JSON.stringify({ scenario: name, coresPerKind: spent }));
}

const clock = { offset: 0 };
const errors: string[] = [];
const home = await mkdtemp(join(tmpdir(), "ace-idle-cpu-"));
const service = new BrowserService({
  dataDir: home,
  executablePath,
  wakeWatch: false,
  now: () => Date.now() + clock.offset,
  onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
  tabLifecycle: {
    policy: defaultTabLifecycle,
    every: 1000,
    set: (delay, work) => {
      const timer = setTimeout(work, delay);
      return () => clearTimeout(timer);
    },
  },
});
const servers: Server[] = [];
try {
  const run = (threadId: string, command: unknown) => service.execute(threadId, command);
  // (a) An agent opened an animated page, then left it.
  const anim = await serve(animated);
  servers.push(anim.server);
  await service.open({ threadId: "a", workspaceId: "w" });
  await run("a", { action: "navigate", url: anim.url });
  await run("a", { action: "snapshot" });
  await measure("a: animated page, unwatched, just after the agent's action");
  clock.offset += 31_000;
  await measure("a: animated page, unwatched, idle half a minute");
  clock.offset += defaultTabLifecycle.freezeAfterMs;
  await measure("a: animated page, unwatched, idle past the freeze threshold");
  await service.closeThread("a");

  // (b) A page whose server has gone away.
  const dev = await serve(polling);
  await service.open({ threadId: "b", workspaceId: "w" });
  await run("b", { action: "navigate", url: dev.url });
  dev.server.closeAllConnections();
  await new Promise<void>((resolve) => dev.server.close(() => resolve()));
  await measure("b: dev page polling a dead server");
  await service.closeThread("b");

  // (c) Several idle kept tabs on animated pages.
  await service.open({ threadId: "c", workspaceId: "w" });
  await run("c", { action: "navigate", url: anim.url });
  for (let index = 0; index < 4; index++) {
    await run("c", { action: "tabs", operation: "open", url: anim.url });
  }
  clock.offset += defaultTabLifecycle.freezeAfterMs + 1000;
  await measure("c: five animated tabs, idle past the freeze threshold");
  console.log(
    JSON.stringify({ tabs: service.state("c").tabs?.map((tab) => tab.lifecycle), errors: errors.length }),
  );
} finally {
  await service.close();
  for (const server of servers) server.close();
  await rm(home, { recursive: true, force: true });
}
