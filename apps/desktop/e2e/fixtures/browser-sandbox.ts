import { staticRenderer } from "./static-renderer.ts";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, cp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { build } from "esbuild";
import { _electron as electron, type ElectronApplication } from "playwright-core";
import { startDaemon } from "../../../daemon/src/index.ts";
import { readConfig } from "../../../daemon/src/config.ts";
import { Command, ThreadId } from "@ace/protocol";
import { randomUUID } from "node:crypto";
import { detectChromium } from "@ace/browser";
import {
  appEnvironment,
  appVersion,
  electronBinary,
  electronBundles,
  mainEntry,
  repo,
} from "../../scripts/common.ts";

export async function browserSandbox(backend: "auto" | "headless" = "auto") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-panel-e2e-")));
  const out = join(root, "Resources", "app");
  const home = join(root, "home");
  await mkdir(home, { mode: 0o700 });
  const executablePath = await detectChromium();
  if (!executablePath) throw new Error("Sandbox Chromium unavailable");
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  let app: ElectronApplication | undefined;
  const web = await staticRenderer(join(out, "renderer"));
  const cleanup = async () => {
    await app?.close().catch(() => {});
    await daemon?.close();
    await web.close();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  };
  let server = createServer();
  let fixturePort = 0;
  try {
    daemon = await startDaemon({
      config: readConfig({
        ACE_HOME: home,
        ACE_PORT: "0",
        ACE_LOG_LEVEL: "silent",
        ACE_WEB_ORIGINS: web.origin,
      }),
      // Threads name Codex but no scenario starts a session; probing the machine's real CLIs
      // can outlast the engine's startup deadline and leave the sandbox without an engine.
      modelInstances: [],
      engine: {
        adapterDiscovery: async () => ({
          claude: { installed: false, auth: "unknown", loginHint: "" },
          codex: {
            installed: true,
            path: process.execPath,
            version: "0.0.0",
            auth: "unknown",
            loginHint: "",
          },
          cursor: { installed: false, auth: "unknown", loginHint: "" },
          opencode: { installed: false, auth: "unknown", loginHint: "" },
        }),
      },
      browser: {
        executablePath,
        backendPreference: () => backend,
        originPolicy: () => true,
        evaluatePolicy: () => true,
        downloadPolicy: () => true,
      },
    });
    server = createServer((req, res) => {
      if (req.url === "/auth" && req.headers.authorization !== "Basic Zml4dHVyZTpmaXh0dXJl") {
        res.writeHead(401, { "www-authenticate": 'Basic realm="Browser fixture"' });
        res.end("Sign in required");
        return;
      }
      if (req.url === "/download") {
        res.writeHead(200, {
          "content-type": "text/plain",
          "content-disposition": 'attachment; filename="fixture.txt"',
        });
        res.end("sandbox download\n");
        return;
      }
      res.setHeader("content-type", "text/html");
      res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${req.url === "/second" ? "Second" : req.url === "/popup" ? "Popup" : "Fixture"}</title>
<style>body{margin:0;font:16px system-ui}button,input,a{margin:8px}#motion{width:100px;height:60px;background:blue;animation:move 1s infinite alternate}@keyframes move{to{transform:translateX(150px)}}#long{height:3000px;background:linear-gradient(white,lightblue)}iframe{width:250px;height:100px}video{width:200px;height:100px}</style>
<h1>Fixture needle</h1><a href="/second">Second page</a><a href="/">First page</a><a href="/download" download>Download fixture</a>
<button id="click" onmouseenter="window.hovered=true" onclick="this.textContent='Clicked '+(++window.clicks)">Click marker</button><input id="name" aria-label="Name" oninput="window.inputs++"><span id="result"></span>
<button onclick="window.open('/popup')">Popup</button><button onclick="alert('Fixture alert')">Alert</button><button onclick="result.textContent=confirm('Fixture confirm')">Confirm</button><button onclick="result.textContent=prompt('Fixture prompt','seed')">Prompt</button>
<input type="file" id="file" aria-label="File"><button id="spa" onclick="history.pushState({},'','/spa')">SPA route</button><div id="motion"></div>${req.url === "/frame" ? "Iframe needle" : `<iframe src="/frame" title="Fixture frame"></iframe><iframe src="http://localhost:${fixturePort}/frame" title="Cross-origin frame"></iframe>`}<canvas id="canvas" width="200" height="100" hidden></canvas><video id="video" autoplay muted playsinline></video><div id="long">Long scroll needle</div>
<script>window.clicks=0;window.inputs=0;let frames=0;function paint(){const c=canvas.getContext('2d');c.fillStyle=frames++%2?'red':'blue';c.fillRect(0,0,200,100);requestAnimationFrame(paint)}paint();video.srcObject=canvas.captureStream(30);</script>`);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture port");
    fixturePort = address.port;
    const url = `http://127.0.0.1:${address.port}/`;
    await mkdir(join(root, "Resources", "daemon"), { recursive: true });
    await cp(
      join(repo, "packages/workspace/dist/descriptor.node"),
      join(root, "Resources", "daemon", "descriptor.node"),
    );
    await cp(join(repo, "apps/desktop/resources"), join(root, "Resources", "icons"), {
      recursive: true,
    });
    await writeFile(
      join(root, "Resources", "package.json"),
      JSON.stringify({ name: "ace", version: appVersion(), main: "launch.mjs" }),
    );
    await writeFile(
      join(root, "Resources", "launch.mjs"),
      `import { app, shell } from 'electron';
Object.defineProperty(app,'isPackaged',{value:true});Object.defineProperty(process,'resourcesPath',{value:import.meta.dirname});
process.argv=[process.argv[0]];app.setAsDefaultProtocolClient=()=>true;app.setLoginItemSettings=()=>{};globalThis.testOpened=[];shell.openExternal=async url=>{globalThis.testOpened.push(url)};
await import('./app/${mainEntry}');`,
    );
    for (const options of electronBundles(out, process.env)) await build(options);
    execFileSync(
      "bun",
      [
        "x",
        "vite",
        "build",
        "--outDir",
        join(out, "renderer"),
        "--emptyOutDir",
        "--logLevel",
        "warn",
      ],
      { cwd: join(repo, "apps/web"), stdio: "inherit", env: { ...process.env, GOMAXPROCS: "1" } },
    );
    const workspaceId = daemon.store.createWorkspace(home, "Browser sandbox");
    const current = daemon;
    const engine = current.engine;
    if (!engine) throw new Error("Sandbox engine unavailable");
    const prepare = (title: string) => {
      const id = ThreadId.parse(randomUUID());
      const result = engine.handler.handle(
        Command.parse({
          id: randomUUID(),
          deviceId: "sandbox",
          payload: {
            type: "thread.prepare",
            threadId: id,
            workspaceId,
            provider: "codex",
            title,
          },
        }),
        current.store,
      );
      if (!result.ok) throw new Error(`Sandbox thread preparation failed: ${result.error}`);
      // Home leaves empty drafts out of its list; the scenarios switch threads from it.
      current.store.appendEvents(id, [
        { type: "thread.client.updated", changes: { hasSentMessage: true } },
      ]);
      const thread = current.store.getThread(id);
      if (!thread) throw new Error("Sandbox thread unavailable");
      return thread;
    };
    const thread = prepare("Browser fixture");
    const other = prepare("Other fixture");
    const env = appEnvironment(process.env);
    delete env.ACE_DAEMON_URL;
    delete env.ACE_DAEMON_TOKEN;
    delete env.ACE_DAEMON_TOKEN_FILE;
    app = await electron.launch({
      executablePath: await electronBinary(),
      args: [join(root, "Resources"), "--force-device-scale-factor=2"],
      env: {
        ...env,
        HOME: root,
        ACE_HOME: home,
        ACE_DESKTOP_USER_DATA: join(root, "userData"),
        ACE_DESKTOP_DAEMON: "managed",
        ACE_DESKTOP_RENDERER_URL: "",
      },
    });
    // Playwright otherwise auto-dismisses dialogs on attached native targets.
    app.context().on("page", (target) => target.on("dialog", () => {}));
    for (const target of app.context().pages()) target.on("dialog", () => {});
    const page = await app.firstWindow();
    await page.goto(`app://ace/t/${thread.id}`);
    return { app, page, daemon, thread, other, url, root, web, executablePath, close: cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
