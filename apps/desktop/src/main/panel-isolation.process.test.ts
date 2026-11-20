import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import {
  panelInit,
  panelMessageFromTitle,
  panelState,
  panelUrl,
  readPanelMessage,
} from "@ace/html";
import { packagedPolicy } from "./csp.ts";
import { headless, listen, lookups, runElectron } from "./isolation-test-support.ts";

/**
 * A package's panel on desktop (ADR 0200 §5.2), with real Electron, sockets and resolver, isolated
 * exactly as a chat visualization is (ADR 0077): a panel page that tries every way out (network
 * hints, fetch, an image, a socket, a beacon, top navigation) and every way into the app (its
 * document, its location, storage, cookies) reaches none of them, while the person's theme and
 * the bot's state cross in. Out of it come only the panel's typed messages, as text of at most
 * 16 KiB of UTF-8, measured before anything reads them: an action goes only while the person
 * presses, even one the page's script posts itself, and only one its panel declares survives the
 * host's check. What the host's confirm takes is a press only real input makes: a script's click
 * on it, from the app or the page, never counts (ADR 0200 §5.2, amendment 1).
 */

const here = dirname(fileURLToPath(import.meta.url));

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
disableDnsPrefetching(app);
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const phase = (name) => process.stdout.write("phase " + name + "\\n");
app.whenReady().then(async () => {
  await netLog.startLogging(config.netlog, { captureMode: "everything" });
  await isolateVisualizationSession();
  const window = new BrowserWindow({
    show: false,
    width: 900,
    height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, webviewTag: true },
  });
  const guests = [];
  const titles = [];
  window.webContents.on("will-attach-webview", (event, preferences, params) => {
    if (!acceptVisualizationWebview(preferences, params)) event.preventDefault();
  });
  window.webContents.on("did-attach-webview", (_event, guest) => {
    guardVisualizationContents(guest);
    guest.on("page-title-updated", (_e, title) => titles.push(title));
    guests.push(guest);
  });
  phase("load host page");
  await window.loadURL(config.host);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !(guests[0] && guests[0].mainFrame.frames.length > 0)) await settle(100);
  const guest = guests[0];
  await settle(500);
  const page = guest.mainFrame.frames[0];
  phase("send init and state");
  // As the app sends them: posted in the guest's own outer document.
  await guest.executeJavaScript("postMessage(" + JSON.stringify(config.init) + ", '*'); postMessage(" + JSON.stringify(config.state) + ", '*')");
  await settle(300);
  phase("act");
  // With nobody pressing, the page can't act: not through acePanel, nor by posting itself, as text
  // or as the object the bridge once took.
  const unprompted = await page.executeJavaScript("acePanel.act('stop_watching', 'KTM-DEL')");
  await page.executeJavaScript("parent.postMessage(JSON.stringify({ type: 'ace.panel.action', name: 'stop_watching', value: 'forged' }), '*'); parent.postMessage({ type: 'ace.panel.action', name: 'stop_watching', value: 'forged-object' }, '*')");
  await settle(200);
  // While the person presses: a declared action, and one its panel doesn't declare.
  const pressed = await page.executeJavaScript("[acePanel.act('stop_watching', 'KTM-DEL'), acePanel.act('book_it', 1)]", true);
  await settle(200);
  // Messages of the page's own making: an untyped one, and an action with a field too many.
  await page.executeJavaScript("parent.postMessage(JSON.stringify({ type: 'ace.panel.call', tool: 'send_message' }), '*'); parent.postMessage(JSON.stringify({ type: 'ace.panel.action', name: 'stop_watching', value: 'x', extra: true }), '*')", true);
  await settle(200);
  phase("bounds");
  // Over 16 KiB of UTF-8: 20,000 ASCII bytes, and 6,000 euro signs (18,000 bytes in 6,000 units),
  // posted by the page itself while the person presses, and the euros through acePanel too.
  const oversized = await page.executeJavaScript("const big = (value) => JSON.stringify({ type: 'ace.panel.action', name: 'stop_watching', value }); parent.postMessage(big('a'.repeat(20000)), '*'); parent.postMessage(big('€'.repeat(6000)), '*'); [acePanel.act('stop_watching', '€'.repeat(6000)), acePanel.act('stop_watching', '€'.repeat(1000))]", true);
  await settle(300);
  phase("confirm press");
  // The host's own control, outside the page: a script's click on it, and the person's real one.
  await window.webContents.executeJavaScript("document.getElementById('confirm').click()");
  const box = await window.webContents.executeJavaScript("(() => { const r = document.getElementById('confirm').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()");
  window.webContents.sendInputEvent({ type: "mouseDown", x: box.x, y: box.y, button: "left", clickCount: 1 });
  window.webContents.sendInputEvent({ type: "mouseUp", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await settle(300);
  const presses = await window.webContents.executeJavaScript("window.presses");
  await guest.executeJavaScript("postMessage({ type: 'ace.panel.ping', n: 7 }, '*')");
  await settle(500);
  const seen = await page.executeJavaScript("document.getElementById('seen').textContent");
  const reach = await page.executeJavaScript("document.getElementById('reach').textContent");
  await settle(1000);
  await netLog.stopLogging();
  writeFileSync(config.out, JSON.stringify({ guests: guests.length, titles, unprompted, pressed, oversized, presses, seen, reach }));
  app.exit(0);
}).catch((error) => {
  process.stdout.write("failed " + (error?.stack ?? String(error)) + "\\n");
  app.exit(1);
});
`;

const Result = z.object({
  guests: z.number(),
  titles: z.array(z.string()),
  unprompted: z.boolean(),
  pressed: z.array(z.boolean()),
  oversized: z.array(z.boolean()),
  presses: z.array(z.boolean()),
  seen: z.string(),
  reach: z.string(),
});

/** A panel page that tries every way out and every way in, and shows what crossed in. */
function panelPage(target: string, suffix: string): string {
  return `<!doctype html><html><head><title>Watched trips</title></head><body>
<p id="seen"></p><p id="reach"></p>
<script>
const seen = [];
const show = () => { document.getElementById('seen').textContent = seen.join(' | '); };
addEventListener('ace:init', (event) => {
  const color = getComputedStyle(document.documentElement).getPropertyValue('--foreground').trim();
  seen.push('init:' + event.detail.runtime + ':' + event.detail.scheme + ':' + color);
  show();
});
addEventListener('ace:state', (event) => { seen.push('state:' + JSON.stringify(event.detail)); show(); });
const reach = [];
const attempt = (name, run) => { try { run(); reach.push(name + ':ran'); } catch (error) { reach.push(name + ':' + error.name); } };
attempt('parent-document', () => parent.document.title);
attempt('top-location', () => top.location.href);
attempt('storage', () => localStorage.length);
attempt('cookie', () => { document.cookie = 'leak=1'; });
attempt('fetch', () => { fetch('${target}/fetch').catch(() => {}); fetch('https://fetch.${suffix}/').catch(() => {}); });
attempt('image', () => { new Image().src = '${target}/image'; new Image().src = 'https://image.${suffix}/p.png'; });
attempt('socket', () => { new WebSocket('${target.replace("http:", "ws:")}/socket'); });
attempt('beacon', () => { navigator.sendBeacon('${target}/beacon', 'leak'); });
attempt('preconnect', () => { const link = document.createElement('link'); link.rel = 'preconnect'; link.href = 'https://hint.${suffix}/'; document.head.append(link); });
attempt('navigate-top', () => { top.location.href = '${target}/navigate'; });
document.getElementById('reach').textContent = reach.join(' ');
</script></body></html>`;
}

const attribute = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

it.skipIf(headless)(
  "a panel's page reaches neither the network nor the app, and only its declared actions cross out",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ace-panel-net-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const suffix = `${randomUUID()}.ace-panel.test`;
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
    const theme = { colorScheme: "dark" as const, foreground: "rgb(240, 240, 240)" };
    const panel = panelUrl(panelPage(target, suffix), theme);
    // The app's side: the panel's webview, and a confirm control of the host's own that records
    // whether each press on it came from real input.
    const hostPage = `<!doctype html><html><body style="margin:0">
<webview partition="ace-visualization" src="${attribute(panel)}" style="display:flex;width:400px;height:700px"></webview>
<button id="confirm" style="display:block;width:120px;height:40px">Confirm</button>
<script>window.presses = []; document.getElementById('confirm').addEventListener('click', (event) => window.presses.push(event.isTrusted));</script>
</body></html>`;
    const policy = packagedPolicy({ index: hostPage, daemonOrigins: [], dynamicDaemons: false });
    const host = await listen(
      createServer((_request, response) => {
        response.writeHead(200, { "content-security-policy": policy, "content-type": "text/html" });
        response.end(hostPage);
      }),
    );
    const out = join(root, "result.json");
    const netlog = join(root, "netlog.json");
    await runElectron(
      harness,
      here,
      root,
      {
        host: `${host}/`,
        out,
        netlog,
        init: panelInit(theme, false, { width: 400, height: 700 }),
        state: panelState({ trips: [{ route: "KTM-DEL", fare: 182 }] }),
      },
      "panel",
    );
    const result = Result.parse(JSON.parse(await readFile(out, "utf8")));
    expect(result.guests).toBe(1);

    // Theme and state crossed in; the theme's tokens are the page's CSS variables.
    expect(result.seen).toContain("init:1:dark:rgb(240, 240, 240)");
    expect(result.seen).toContain('state:{"trips":[{"route":"KTM-DEL","fare":182}]}');

    // Nothing of the app is reachable, and the page can't navigate it.
    for (const way of ["parent-document", "top-location", "storage", "cookie", "navigate-top"])
      expect(result.reach).not.toContain(`${way}:ran`);
    expect(result.reach).toContain("preconnect:NotSupportedError");
    expect(hits).toEqual([]);
    expect(connections).toBe(0);
    expect((await lookups(netlog)).filter((name) => name.includes(suffix))).toEqual([]);

    // Nothing over the bound left the page's frame, not even cut short: the 6,000 euro signs are
    // under 16K UTF-16 units, so only a bound in bytes stops them.
    expect(result.titles.some((title) => title.includes("€".repeat(1001)))).toBe(false);
    expect(result.titles.some((title) => title.includes("a".repeat(16 * 1024)))).toBe(false);

    // Out came only the panel's typed messages, as text, through the outer document's title.
    const texts = result.titles.map(panelMessageFromTitle).filter((text) => text !== undefined);
    expect(texts.every((text) => new TextEncoder().encode(text).length <= 16 * 1024)).toBe(true);
    const sent: unknown[] = texts.map((text) => JSON.parse(text));
    const types = new Set(
      sent.map((message) => z.object({ type: z.string() }).parse(message).type),
    );
    expect(
      [...types].every(
        (type) =>
          type === "ace.panel.action" ||
          type === "ace.panel.pong" ||
          type === "ace.html.height" ||
          type === "ace.panel.fault",
      ),
    ).toBe(true);
    expect(types.has("ace.panel.call")).toBe(false);
    expect(sent).toContainEqual({ type: "ace.panel.pong", n: 7 });

    // Unprompted, nothing went, even what the page posted itself; pressed, both went out, and the
    // host keeps the declared one only. Over the bound, nothing went; under it, euros did.
    expect(result.unprompted).toBe(false);
    expect(result.pressed).toEqual([true, true]);
    expect(result.oversized).toEqual([false, true]);
    expect(texts.some((text) => text.includes("forged"))).toBe(false);
    const declared = new Set(["stop_watching"]);
    const actions = texts
      .map((text) => readPanelMessage(text, declared))
      .filter((message) => message?.type === "ace.panel.action");
    expect(actions).toEqual([
      { type: "ace.panel.action", name: "stop_watching", value: "KTM-DEL" },
      { type: "ace.panel.action", name: "stop_watching", value: "€".repeat(1000) },
    ]);

    // The host's confirm: a script's click is not trusted, the person's real press is.
    expect(result.presses).toEqual([false, true]);
  },
);
