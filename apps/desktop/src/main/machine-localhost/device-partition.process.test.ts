import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";

/**
 * Real Electron, real sockets: a machine's partition as the app sets it up (ADR 0194), with a
 * tunnel to this computer's own loopback standing in for the machine. It checks the proxy's
 * secret is answered only for its own partition, that HTTP, websockets and a service worker reach
 * the machine's localhost through it, and that public pages and public frames don't, by their
 * initiator and method, redirects included.
 */

const here = dirname(fileURLToPath(import.meta.url));
const electron: unknown = createRequire(import.meta.url)("electron");

const harness = `
import { app, BrowserWindow, session } from "electron";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { DeviceTabs } from "./device-tabs.ts";
import { loopbackTunnel } from "./loopback-tunnel.ts";
import { MachineSessions } from "./machine-sessions.ts";
const config = JSON.parse(readFileSync(process.argv.at(-1), "utf8"));
app.commandLine.appendSwitch("host-resolver-rules", "MAP public.test 127.0.0.1");
app.on("window-all-closed", () => {});
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const phase = (name) => process.stdout.write("phase " + name + "\\n");
const tunnel = loopbackTunnel();
const sessions = new MachineSessions({
  tunnel: () => tunnel,
  secret: () => randomBytes(32).toString("base64url"),
  now: Date.now,
  log: (message) => process.stdout.write("log " + message + "\\n"),
});
const logins = [];
// As machine-localhost/index.ts wires it.
app.on("login", (event, contents, _details, ask, callback) => {
  const answer = sessions.proxyLogin(ask, contents ?? undefined);
  logins.push(answer ? "answered" : "refused");
  if (!answer) return;
  event.preventDefault();
  callback(answer.username, answer.password);
});
async function visit(partitionSession, url, waitMs, script) {
  const window = new BrowserWindow({ show: false, webPreferences: { session: partitionSession } });
  await Promise.race([window.loadURL(url).catch(() => {}), settle(5000)]);
  await settle(waitMs);
  const value = script ? await window.webContents.executeJavaScript(script).catch((e) => "error " + e) : null;
  const title = window.webContents.getTitle();
  window.destroy();
  return { title, value };
}
app.whenReady().then(async () => {
  phase("ready");
  const machine = await sessions.get("machine-1");
  const partition = session.fromPartition(machine.partition);
  const results = {};
  phase("own page");
  results.own = await visit(partition, config.dev + "/page", 300,
    "Promise.all([document.body.textContent, fetch('" + config.dev2 + "/cross-port').then(r => r.text()), new Promise(r => { const w = new WebSocket('" + config.dev.replace("http:", "ws:") + "/socket'); w.onmessage = (e) => r(e.data); w.onerror = () => r('ws error'); setTimeout(() => r('ws timeout'), 3000); })])");
  phase("service worker");
  results.worker = await visit(partition, config.dev + "/sw-page", 2500, null);
  phase("public page");
  for (const name of ["form-post", "form-307", "form-302", "link-get"])
    results[name] = await visit(partition, config.public + "/" + name, 1200, null);
  phase("person redirect");
  // The person's own load of a public address that redirects to localhost: no initiator.
  results.personRedirect = await visit(partition, config.public + "/person-307", 600, null);
  results.publicFetch = await visit(partition, config.public + "/blank", 200,
    "fetch('" + config.dev + "/from-public-page').then(() => 'reached', () => 'blocked')");
  phase("public frame");
  results.frame = await visit(partition, config.dev + "/with-public-frame", 2000, null);
  phase("another session");
  // Another session pointed at the machine's proxy (as no app session is) gets no secret.
  const rule = await partition.resolveProxy(config.dev + "/");
  results.rule = rule;
  const other = session.fromPartition("not-the-machine");
  await other.setProxy({ proxyRules: "http://" + rule.replace(/^PROXY /, ""), proxyBypassRules: "*,<-loopback>" });
  results.other = await visit(other, config.dev + "/from-other-session", 500, null);
  results.logins = logins;
  phase("closed while opening");
  // A tab closed while its machine's partition is still being set up leaves no view behind,
  // and the machine is let go.
  const idle = [];
  const tabs = new DeviceTabs({
    sessions,
    state: () => {},
    openTab: () => {},
    focusAddress: () => {},
    left: () => {},
    idle: (machineId) => idle.push(machineId),
    platform: process.platform,
    log: () => {},
  });
  const host = new BrowserWindow({ show: false });
  await host.loadURL("about:blank");
  const before = host.contentView.children.length;
  const opening = tabs.open(
    { tabId: "t1", machineId: "machine-2", url: config.dev + "/never-shown" },
    { contents: host.webContents, window: host, zoom: 1 },
  ).then(() => "opened", () => "given up");
  tabs.close("t1");
  results.closedWhileOpening = {
    outcome: await opening,
    views: host.contentView.children.length - before,
    held: tabs.holds("machine-2"),
    idle,
  };
  await settle(300);
  host.destroy();
  writeFileSync(config.out, JSON.stringify(results));
  await sessions.close();
  app.exit(0);
}).catch((error) => {
  process.stdout.write("failed " + (error?.stack ?? String(error)) + "\\n");
  app.exit(1);
});
`;

const Visit = z.object({ title: z.string(), value: z.unknown() });
const Result = z.object({
  own: Visit,
  worker: Visit,
  "form-post": Visit,
  "form-307": Visit,
  "form-302": Visit,
  "link-get": Visit,
  personRedirect: Visit,
  publicFetch: Visit,
  frame: Visit,
  other: Visit,
  logins: z.array(z.string()),
  rule: z.string(),
  closedWhileOpening: z.object({
    outcome: z.string(),
    views: z.number(),
    held: z.boolean(),
    idle: z.array(z.string()),
  }),
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() =>
    new Promise<void>((resolve) => server.close(() => resolve())).then(() => undefined),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No listener");
  return address.port;
}

const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;

const headless =
  process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;

it.skipIf(headless)(
  "a machine's partition reaches its localhost through the proxy, and public pages don't",
  async () => {
    if (typeof electron !== "string") throw new Error("Electron binary not installed");
    const root = await mkdtemp(join(tmpdir(), "ace-device-partition-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    // The machine's dev servers: every request they see, with whether it carried the proxy's
    // credentials (it never should).
    const hits: string[] = [];
    let leakedCredentials = 0;
    let devPort = 0;
    let publicPort = 0;
    const dev = createServer((request, response) => {
      hits.push(`${request.method} ${request.url}`);
      if (request.headers["proxy-authorization"]) leakedCredentials++;
      const devUrl = `http://localhost:${devPort}`;
      if (request.url === "/sw.js") {
        response.writeHead(200, { "content-type": "text/javascript" });
        return response.end(
          "self.addEventListener('install', () => self.skipWaiting());" +
            "self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));" +
            "self.addEventListener('fetch', (e) => { if (e.request.url.endsWith('/via-worker')) e.respondWith(fetch('/worker-inner')); });",
        );
      }
      if (request.url === "/sw-page") {
        response.writeHead(200, { "content-type": "text/html" });
        return response.end(
          page(
            "<script>navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then(() => new Promise((r) => setTimeout(r, 300))).then(() => fetch('/via-worker')).then((r) => r.text()).then((t) => document.title = t, (e) => document.title = 'error ' + e)</script>",
          ),
        );
      }
      if (request.url === "/with-public-frame") {
        response.writeHead(200, { "content-type": "text/html" });
        return response.end(page(`<iframe src="http://public.test:${publicPort}/frame"></iframe>`));
      }
      response.writeHead(200, {
        "content-type": "text/html",
        "access-control-allow-origin": "*",
      });
      response.end(`machine ${request.method} ${request.url} ${devUrl}`);
    });
    dev.on("upgrade", (request, socket) => {
      hits.push(`UPGRADE ${request.url}`);
      const accept = createHash("sha1")
        .update(
          `${String(request.headers["sec-websocket-key"])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
        )
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      socket.write(Buffer.from([0x81, 0x02, 0x68, 0x69])); // "hi"
    });
    devPort = await listen(dev);
    const dev2 = createServer((request, response) => {
      hits.push(`${request.method} :2${request.url}`);
      response.writeHead(200, { "access-control-allow-origin": "*" });
      response.end("other port");
    });
    const dev2Port = await listen(dev2);
    const machine = `http://localhost:${devPort}`;
    const site = createServer((request, response) => {
      const form = (action: string) =>
        page(
          `<form method="post" action="${action}"><input name="a" value="1"></form><script>document.forms[0].submit()</script>`,
        );
      if (request.url === "/person-307") {
        response.writeHead(307, { location: `${machine}/person-after-307` });
        return response.end();
      }
      response.writeHead(
        request.url === "/r307" ? 307 : request.url === "/r302" ? 302 : 200,
        request.url === "/r307"
          ? { location: `${machine}/after-307` }
          : request.url === "/r302"
            ? { location: `${machine}/after-302` }
            : { "content-type": "text/html" },
      );
      if (request.url === "/form-post") return response.end(form(`${machine}/posted`));
      if (request.url === "/form-307") return response.end(form("/r307"));
      if (request.url === "/form-302") return response.end(form("/r302"));
      if (request.url === "/link-get")
        return response.end(page(`<script>location.href = "${machine}/oauth-back"</script>`));
      if (request.url === "/frame")
        return response.end(
          page(
            `<script>fetch("${machine}/from-public-frame").catch(() => {}); new WebSocket("ws://localhost:${devPort}/socket-from-public-frame");</script>`,
          ),
        );
      response.end(page(""));
    });
    publicPort = await listen(site);
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
    const config = join(root, "config.json");
    await writeFile(
      config,
      JSON.stringify({
        dev: machine,
        dev2: `http://127.0.0.1:${dev2Port}`,
        public: `http://public.test:${publicPort}`,
        out,
      }),
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [main, `--user-data-dir=${join(root, "profile")}`, config], {
      env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    onTestFinished(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-4096);
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Electron did not finish:\n${output}`)),
        25_000,
      );
      child.once("exit", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
      child.once("error", reject);
    });
    if (code !== 0) throw new Error(`Electron exited with ${code}:\n${output}`);
    const result = Result.parse(JSON.parse(await readFile(out, "utf8")));

    // Finding 2: the partition's browser answered the proxy's challenge without a prompt, on
    // page loads, a cross-port fetch and a websocket (a CONNECT), and the credentials never
    // reached the machine. Another session was refused the secret.
    expect(result.rule).toMatch(/^PROXY 127\.0\.0\.1:\d+$/);
    expect(result.own.value).toEqual([`machine GET /page ${machine}`, "other port", "hi"]);
    expect(hits).toEqual(
      expect.arrayContaining(["GET /page", "GET :2/cross-port", "UPGRADE /socket"]),
    );
    expect(leakedCredentials).toBe(0);
    expect(result.logins).toContain("answered");
    expect(result.logins).toContain("refused");
    expect(hits).not.toContain("GET /from-other-session");
    // Finding 4: the localhost page's own service worker, which has no frame, still works.
    expect(result.worker.title).toBe(`machine GET /worker-inner ${machine}`);
    // Finding 1: a public page's form post, and a 307 that keeps it, never reach the machine;
    // a 302 (now a GET) and a link do, as an OAuth return does.
    expect(hits).not.toContain("POST /posted");
    expect(hits).not.toContain("POST /after-307");
    expect(hits).toContain("GET /after-302");
    expect(hits).toContain("GET /oauth-back");
    // The person's own load stays theirs through a 307 to localhost.
    expect(hits).toContain("GET /person-after-307");
    // Finding 4: a public page, and a public frame inside a localhost page, reach nothing on
    // the machine: no fetch, no websocket.
    expect(result.publicFetch.value).toBe("blocked");
    expect(hits).not.toContain("GET /from-public-page");
    expect(hits).toContain("GET /with-public-frame");
    expect(hits).not.toContain("GET /from-public-frame");
    expect(hits).not.toContain("UPGRADE /socket-from-public-frame");
    // Finding 7: closing a tab while it opens gives the open up, with no orphan view.
    expect(result.closedWhileOpening).toEqual({
      outcome: "given up",
      views: 0,
      held: false,
      idle: ["machine-2"],
    });
    expect(hits).not.toContain("GET /never-shown");
  },
  30_000,
);
