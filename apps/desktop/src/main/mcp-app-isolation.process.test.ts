import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { mcpAppPanelUrl, mcpAppStep, panelMessageFromTitle, readMcpAppMessage } from "@ace/html";
import { packagedPolicy } from "./csp.ts";
import { headless, listen, lookups, runElectron } from "./isolation-test-support.ts";

/**
 * An MCP app's page shown as a panel on desktop (ADR 0202 §4), with real Electron, sockets and
 * resolver: in a package panel's sandbox, a page that tries every way out (fetch, an image, a
 * socket, a beacon, a hint, top navigation) and into the app (its document, storage, cookies)
 * reaches none of them, whatever MCP Apps lets a host allow. Out of it comes only JSON-RPC, as
 * text within the panel bound: a tool call or message it posts with nobody using the page is
 * answered with an error by the outer document and never reaches the app, nor does one over the
 * bound, nor an object posted straight to the outer document past the page bridge (it takes text
 * only); with the person pressing, its request reaches the host, which reads it as the page's,
 * and the answers reach a page that hears only its parent, as MCP Apps' transport does.
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
  phase("theme");
  await guest.executeJavaScript("postMessage(" + JSON.stringify(config.theme) + ", '*')");
  await settle(200);
  phase("unprompted");
  // Nobody is using the page: what MCP Apps' transport posts, and text of the page's making.
  await page.executeJavaScript("parent.postMessage({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: { protocolVersion: '2026-01-26' } }, '*'); parent.postMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'move_card', arguments: { card: 1 } } }, '*'); parent.postMessage({ jsonrpc: '2.0', id: 3, method: 'ui/message', params: { role: 'user', content: { type: 'text', text: 'forged' } } }, '*'); parent.postMessage(JSON.stringify({ type: 'ace.panel.action', name: 'x', value: 'forged' }), '*'); parent.postMessage({ method: 'tools/call', id: 9 }, '*')");
  await settle(300);
  phase("pressed");
  // The person is pressing in the page: a tool call and a link go; a message over the bound
  // doesn't, nor an object posted to the outer document itself rather than as text.
  await page.executeJavaScript("parent.postMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'move_card', arguments: { card: 3 } } }, '*'); parent.postMessage({ jsonrpc: '2.0', id: 5, method: 'ui/open-link', params: { url: 'https://example.com/' } }, '*'); parent.postMessage({ jsonrpc: '2.0', id: 6, method: 'ui/message', params: { role: 'user', content: { type: 'text', text: '€'.repeat(6000) } } }, '*'); top.postMessage({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'move_card', arguments: { card: 8 } } }, '*')", true);
  await settle(300);
  phase("answers");
  await guest.executeJavaScript("postMessage({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2026-01-26' } }, '*'); postMessage({ type: 'ace.panel.ping', n: 7 }, '*')");
  await settle(500);
  const got = await page.executeJavaScript("document.getElementById('got').textContent");
  const reach = await page.executeJavaScript("document.getElementById('reach').textContent");
  const color = await page.executeJavaScript("getComputedStyle(document.documentElement).getPropertyValue('--foreground').trim()");
  await settle(1000);
  await netLog.stopLogging();
  writeFileSync(config.out, JSON.stringify({ guests: guests.length, titles, got, reach, color }));
  app.exit(0);
}).catch((error) => {
  process.stdout.write("failed " + (error?.stack ?? String(error)) + "\\n");
  app.exit(1);
});
`;

const Result = z.object({
  guests: z.number(),
  titles: z.array(z.string()),
  got: z.string(),
  reach: z.string(),
  color: z.string(),
});

/** An MCP app's page that tries every way out and in, and keeps what its host answered. */
function appPage(target: string, suffix: string): string {
  return `<!doctype html><html><head><title>Board</title></head><body>
<p id="got"></p><p id="reach"></p>
<script>
const got = [];
addEventListener('message', (event) => {
  const data = event.data;
  if (event.source !== parent || !data || data.jsonrpc !== '2.0' || data.id === undefined) return;
  got.push(data.id + ':' + (data.error ? 'error:' + data.error.message : 'result'));
  document.getElementById('got').textContent = got.join(' | ');
});
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
  "an MCP app's page reaches neither the network nor the app, and only JSON-RPC the person prompted crosses",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ace-mcp-app-net-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const suffix = `${randomUUID()}.ace-mcp-app.test`;
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
    const page = mcpAppPanelUrl(appPage(target, suffix), theme);
    const hostPage = `<!doctype html><html><body style="margin:0">
<webview partition="ace-visualization" src="${attribute(page)}" style="display:flex;width:400px;height:700px"></webview>
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
        theme: { type: "ace.panel.theme", tokens: { foreground: "rgb(1, 2, 3)" }, scheme: "dark" },
      },
      "mcp-app",
    );
    const result = Result.parse(JSON.parse(await readFile(out, "utf8")));
    expect(result.guests).toBe(1);
    // The person's theme crossed in as the page's CSS variables.
    expect(result.color).toBe("rgb(1, 2, 3)");

    // Nothing of the app is reachable, and nothing reached the network.
    for (const way of ["parent-document", "top-location", "storage", "cookie", "navigate-top"])
      expect(result.reach).not.toContain(`${way}:ran`);
    expect(hits).toEqual([]);
    expect(connections).toBe(0);
    expect((await lookups(netlog)).filter((name) => name.includes(suffix))).toEqual([]);

    // Out came JSON-RPC as text within the bound, through the outer document's title.
    const texts = result.titles.map(panelMessageFromTitle).filter((text) => text !== undefined);
    expect(texts.every((text) => new TextEncoder().encode(text).length <= 16 * 1024)).toBe(true);
    expect(texts.some((text) => text.includes("forged"))).toBe(false);
    const read = texts.map(readMcpAppMessage).filter((message) => message !== undefined);
    const ids = read.flatMap((message) => ("id" in message ? [message.id] : []));
    // Unprompted, only the page's initialize went; pressed, its tool call and link went (not the
    // object posted past the page bridge).
    expect(ids).toEqual([1, 4, 5]);
    expect(read).toContainEqual({ type: "ace.panel.pong", n: 7 });

    // What went is the page's to the host: its tool call goes to the bot as its request.
    const facts = { title: "Fake", tools: [{ name: "move_card", app: true }] };
    const steps = read.map((message) => mcpAppStep(message, facts).kind);
    expect(steps).toContain("deliver");
    expect(steps).toContain("open-link");

    // The page heard why the rest didn't go: no person using it, or over the bound.
    expect(result.got).toContain("2:error:A page sends this only while the person is using it.");
    expect(result.got).toContain("3:error:A page sends this only while the person is using it.");
    expect(result.got).toContain("6:error:The message is larger than 16 KiB.");
    expect(result.got).toContain("1:result");
  },
);
