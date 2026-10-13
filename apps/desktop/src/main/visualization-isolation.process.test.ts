import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { visualizationUrl } from "@ace/html";
import { packagedPolicy } from "./csp.ts";

/**
 * Real Electron, real sockets, real resolver: a visualization page that tries every way out
 * (preconnect and dns-prefetch hints, prefetch, preload, fetch, an external image, a WebSocket
 * and a beacon) reaches nothing, while its own inline script still runs.
 */

const here = dirname(fileURLToPath(import.meta.url));
const electron: unknown = createRequire(import.meta.url)("electron");

/**
 * The app's real isolation, wired the way main-window.ts wires it, inside a page served with the
 * packaged renderer's CSP. "control" loads the same page in the default session without it.
 */
const harness = `
import { app, BrowserWindow, netLog } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import {
  acceptVisualizationWebview,
  disableDnsPrefetching,
  guardVisualizationContents,
  isolateVisualizationSession,
} from "./visualization-isolation.ts";
const config = JSON.parse(readFileSync(process.argv.at(-1), "utf8"));
const protectedRun = config.mode === "protected";
if (protectedRun) disableDnsPrefetching(app);
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const finish = async (result) => {
  await settle(1500);
  await netLog.stopLogging();
  writeFileSync(config.out, JSON.stringify(result));
  app.exit(0);
};
app.whenReady().then(async () => {
  await netLog.startLogging(config.netlog, { captureMode: "everything" });
  if (!protectedRun) {
    const window = new BrowserWindow({ show: false });
    await window.loadURL(config.raw);
    return finish({ guests: 0 });
  }
  await isolateVisualizationSession();
  const window = new BrowserWindow({
    show: false,
    width: 900,
    height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, webviewTag: true },
  });
  const guests = [];
  window.webContents.on("will-attach-webview", (event, preferences, params) => {
    if (!acceptVisualizationWebview(preferences, params)) event.preventDefault();
  });
  window.webContents.on("did-attach-webview", (_event, guest) => {
    guardVisualizationContents(guest);
    guests.push(guest);
  });
  await window.loadURL(config.host);
  const deadline = Date.now() + 20000;
  const titles = () => guests.map((guest) => guest.getTitle());
  while (Date.now() < deadline && !(guests.length === 2 && titles().some((title) => title.startsWith("ace.html.height:"))))
    await settle(100);
  const visual = guests.find((guest) => guest.getTitle().startsWith("ace.html.height:"));
  const page = visual?.mainFrame.frames[0];
  const slider = page
    ? await page.executeJavaScript(
        "const s = document.getElementById('slider'); s.value = 73; s.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('value').textContent",
      )
    : null;
  const blocked = page ? await page.executeJavaScript("document.getElementById('attempts').textContent") : null;
  await settle(300);
  return finish({ guests: guests.length, slider, blocked, title: visual?.getTitle() ?? null });
});
`;

const Result = z.object({
  guests: z.number(),
  slider: z.string().nullable().optional(),
  blocked: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
});

/** Every way out a script has, aimed at a counting local server and at unresolvable names. */
function leakingPage(target: string, suffix: string): string {
  return `<!doctype html><html><head><title>Leak</title></head><body style="margin:0">
<div style="height:240px"><p id="value">50</p>
<input id="slider" type="range" min="0" max="100" value="50" oninput="document.getElementById('value').textContent = this.value">
<p id="attempts"></p></div>
<script>
const outcomes = [];
const attempt = (name, run) => { try { run(); outcomes.push(name + ':ran'); } catch (error) { outcomes.push(name + ':' + error.name); } };
for (const rel of ['preconnect', 'dns-prefetch']) attempt(rel, () => {
  const link = document.createElement('link'); link.rel = rel; link.href = 'https://' + rel + '.${suffix}/'; document.head.append(link);
  const local = document.createElement('link'); local.rel = rel; local.href = '${target}/' + rel; document.head.append(local);
});
for (const rel of ['prefetch', 'preload']) attempt(rel, () => {
  const link = document.createElement('link'); link.rel = rel; link.href = '${target}/' + rel; link.as = 'fetch'; document.head.append(link);
});
attempt('markup', () => { document.head.insertAdjacentHTML('beforeend', '<link rel="preconnect" href="https://markup.${suffix}/">'); });
attempt('fetch', () => { fetch('${target}/fetch').catch(() => {}); fetch('https://fetch.${suffix}/').catch(() => {}); });
attempt('image', () => { const image = new Image(); image.src = 'https://image.${suffix}/pixel.png'; document.body.append(image); new Image().src = '${target}/image'; });
attempt('socket', () => { new WebSocket('${target.replace("http:", "ws:")}/socket'); });
attempt('beacon', () => { navigator.sendBeacon('${target}/beacon', 'leak'); });
document.getElementById('attempts').textContent = outcomes.join(' ');
</script></body></html>`;
}

const attribute = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No listener");
  onTestFinished(() =>
    new Promise<void>((resolve) => server.close(() => resolve())).then(() => undefined),
  );
  return `http://127.0.0.1:${address.port}`;
}

/** Resolver lookups from Chromium's NetLog, including DNS-only hints with no HTTP request. */
async function lookups(path: string): Promise<string[]> {
  if ((await stat(path)).size > 64 * 1024 * 1024) throw new Error("NetLog too large");
  const log = z
    .object({
      constants: z.object({ logEventTypes: z.record(z.string(), z.number()) }),
      events: z.array(
        z.object({ type: z.number(), params: z.record(z.string(), z.unknown()).optional() }),
      ),
    })
    .parse(JSON.parse(await readFile(path, "utf8")));
  const resolver = new Set(
    Object.entries(log.constants.logEventTypes)
      .filter(([name]) => name.startsWith("HOST_RESOLVER"))
      .map(([, value]) => value),
  );
  return log.events.flatMap((event) => {
    const host = event.params?.host ?? event.params?.hostname;
    return resolver.has(event.type) && typeof host === "string" ? [host] : [];
  });
}

async function run(mode: "protected" | "control") {
  if (typeof electron !== "string") throw new Error("Electron binary not installed");
  const root = await mkdtemp(join(tmpdir(), "ace-visual-net-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const suffix = `${randomUUID()}.ace-visual.test`;
  const hits: string[] = [];
  let connections = 0;
  const targetServer = createServer((request, response) => {
    hits.push(request.url ?? "");
    response.end("leaked");
  });
  targetServer.on("connection", () => connections++);
  targetServer.on("upgrade", (request, socket) => {
    hits.push(`upgrade ${request.url}`);
    socket.destroy();
  });
  const target = await listen(targetServer);
  const page = leakingPage(target, suffix);
  const raw = `data:text/html;charset=utf-8,${encodeURIComponent(page)}`;
  const visual = visualizationUrl(
    page,
    { colorScheme: "dark", foreground: "rgb(240,240,240)" },
    "interactive",
  );
  const index = "<!doctype html><html><head></head><body></body></html>";
  const policy = packagedPolicy({ index, daemonOrigins: [], dynamicDaemons: false });
  // The app's visualization and, beside it, the same page with none of the in-page defences.
  const hostPage = `<!doctype html><html><body style="margin:0">
<webview partition="ace-visualization" src="${attribute(visual)}" style="display:flex;width:800px;height:400px"></webview>
<webview partition="ace-visualization" src="${attribute(raw)}" style="display:flex;width:800px;height:300px"></webview>
</body></html>`;
  const host = await listen(
    createServer((_request, response) => {
      response.writeHead(200, { "content-security-policy": policy, "content-type": "text/html" });
      response.end(hostPage);
    }),
  );
  const main = join(root, "main.cjs");
  await build({
    stdin: { contents: harness, resolveDir: here, loader: "ts", sourcefile: "harness.ts" },
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    outfile: main,
    logLevel: "silent",
  });
  const out = join(root, "result.json");
  const netlog = join(root, "netlog.json");
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({ mode, raw, host: `${host}/`, out, netlog }));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [main, `--user-data-dir=${join(root, "profile")}`, config], {
    env,
    stdio: "ignore",
  });
  onTestFinished(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Electron did not finish")), 60_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("error", reject);
  });
  return {
    result: Result.parse(JSON.parse(await readFile(out, "utf8"))),
    connections,
    hits,
    leakedLookups: (await lookups(netlog)).filter((name) => name.includes(suffix)),
  };
}

const headless =
  process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;

it.skipIf(headless)(
  "a visualization's script runs but no request, socket or DNS lookup leaves the visualization session",
  async () => {
    // Positive control: the same page outside the visualization session does reach the network,
    // so the observers below would see a leak.
    const control = await run("control");
    expect(control.connections).toBeGreaterThan(0);
    expect(control.hits).toEqual(expect.arrayContaining(["/fetch", "/image", "/beacon"]));
    expect(control.leakedLookups.some((name) => name.includes("dns-prefetch."))).toBe(true);

    const isolated = await run("protected");
    expect(isolated.result.guests).toBe(2);
    // The authored inline handler ran: the slider moved the value.
    expect(isolated.result.slider).toBe("73");
    // The in-page guard refused the hint elements before the network layer saw them.
    expect(isolated.result.blocked).toContain("preconnect:NotSupportedError");
    // Height crossed out through the outer document's title.
    expect(isolated.result.title).toMatch(/^ace\.html\.height:2\d\d$/);
    expect(isolated.hits).toEqual([]);
    expect(isolated.connections).toBe(0);
    expect(isolated.leakedLookups).toEqual([]);
  },
);
