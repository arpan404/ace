import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, cp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { build } from "esbuild";
import { _electron as electron } from "playwright-core";
import { expect, it } from "vitest";
import { z } from "zod";
import { startDaemon } from "../../daemon/src/index.ts";
import { readConfig } from "../../daemon/src/config.ts";
import { createDevThread } from "../../daemon/src/commands.ts";
import {
  appEnvironment,
  appVersion,
  electronBinary,
  electronBundles,
  mainEntry,
  repo,
} from "../scripts/common.ts";

it.runIf(process.env.ACE_E2E_ELECTRON === "1")(
  "bundled desktop registers from an isolated home and places a sharp native page with native input",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ace-native-e2e-")));
    // Release-style chunks, preload and renderer under Resources/app; no repo source imports in Electron.
    const out = join(root, "Resources", "app");
    const home = join(root, "home");
    await mkdir(home, { mode: 0o700 });
    const daemon = await startDaemon({
      config: readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
      browser: { executablePath: "/unavailable/headless", originPolicy: () => true },
    });
    const server = createServer((_req, res) =>
      res.end(
        `<!doctype html><style>body{margin:0;height:4000px}button{width:150px;height:100px}#motion{height:100px;width:100px;background:blue;animation:move .8s infinite alternate}@keyframes move{to{transform:translateX(300px)}}</style><button onclick="this.textContent='Clicked'">Native input</button><div id=motion></div>`,
      ),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test HTTP port");
    const testUrl = `http://127.0.0.1:${address.port}/`;
    let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
    try {
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
        `import { app } from 'electron';
Object.defineProperty(app, 'isPackaged', { value: true });
Object.defineProperty(process, 'resourcesPath', { value: import.meta.dirname });
app.setAsDefaultProtocolClient = () => true;
app.setLoginItemSettings = () => {};
await import('./app/${mainEntry}');`,
      );
      await cp(join(repo, "apps/desktop/resources"), join(root, "resources"), { recursive: true });
      await cp(join(repo, "apps/desktop/build"), join(root, "build"), { recursive: true });
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
        { cwd: join(repo, "apps/web"), stdio: "inherit" },
      );
      const workspaceId = daemon.store.createWorkspace(home, "Native test");
      const thread = createDevThread(daemon.store, workspaceId);
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
      app.process().stdout?.on("data", (chunk: Buffer) => {
        const message = chunk.toString().replace(/[a-f0-9]{64}/gi, "<REDACTED>");
        if (/backend/i.test(message)) console.log(message.trim());
      });
      app.process().stderr?.on("data", (chunk: Buffer) => {
        const message = chunk.toString().replace(/[a-f0-9]{64}/gi, "<REDACTED>");
        if (/Error|backend/i.test(message)) console.log(message.trim());
      });
      const renderer = await app.firstWindow();
      // No headless executable exists: an auto open can succeed only after actual desktop registration.
      let state: Awaited<ReturnType<typeof daemon.browser.open>> | undefined;
      await expect
        .poll(
          async () => {
            try {
              state = await daemon.browser.open({ threadId: thread.id, workspaceId });
              return state.backend;
            } catch {
              return "unregistered";
            }
          },
          { timeout: 30_000 },
        )
        .toBe("embedded");
      await daemon.browser.execute(thread.id, { action: "navigate", url: testUrl });
      const leaseOwner = "e2e-renderer";
      daemon.browser.takeover(thread.id, leaseOwner);
      await renderer.evaluate(
        async ({ threadId, owner }) => {
          const ace: unknown = Reflect.get(globalThis, "ace");
          if (typeof ace !== "object" || ace === null || !("browser" in ace))
            throw new Error("No desktop bridge");
          const browser = ace.browser;
          if (
            typeof browser !== "object" ||
            browser === null ||
            !("place" in browser) ||
            typeof browser.place !== "function"
          )
            throw new Error("No native placement bridge");
          await Reflect.apply(browser.place, browser, [
            { threadId, bounds: { x: 200, y: 180, width: 600, height: 400 }, visible: true, owner },
          ]);
        },
        { threadId: thread.id, owner: leaseOwner },
      );
      const native = await app.evaluate(async ({ BrowserWindow, webContents }, pageUrl) => {
        const contents = webContents.getAllWebContents().find((page) => page.getURL() === pageUrl);
        const window = BrowserWindow.getAllWindows()[0];
        if (!contents || !window) throw new Error("Native page missing");
        const view = window.contentView.children.find(
          (child) => "webContents" in child && child.webContents === contents,
        );
        if (!view) throw new Error("Native view missing");
        const pixels = (await contents.capturePage()).toPNG();
        return {
          bounds: view.getBounds(),
          visible: view.getVisible(),
          onTop: window.contentView.children.at(-1) === view,
          dpr: await contents.executeJavaScript("devicePixelRatio"),
          pixelWidth: pixels.readUInt32BE(16),
          pixelHeight: pixels.readUInt32BE(20),
        };
      }, testUrl);
      expect(native).toMatchObject({
        bounds: { x: 200, y: 180, width: 600, height: 400 },
        visible: true,
        onTop: true,
        dpr: 2,
      });
      expect(native.pixelWidth).toBeGreaterThanOrEqual(1200);
      expect(native.pixelHeight).toBeGreaterThanOrEqual(800);
      await expect
        .poll(async () =>
          app?.evaluate(async ({ webContents }, pageUrl) => {
            const contents = webContents
              .getAllWebContents()
              .find((page) => page.getURL() === pageUrl);
            if (!contents) throw new Error("Native page missing");
            contents.sendInputEvent({
              type: "mouseDown",
              x: 30,
              y: 30,
              button: "left",
              clickCount: 1,
            });
            contents.sendInputEvent({
              type: "mouseUp",
              x: 30,
              y: 30,
              button: "left",
              clickCount: 1,
            });
            return contents.executeJavaScript("document.querySelector('button').textContent");
          }, testUrl),
        )
        .toBe("Clicked");
      await app.evaluate(({ webContents }, pageUrl) => {
        const contents = webContents.getAllWebContents().find((page) => page.getURL() === pageUrl);
        contents?.sendInputEvent({ type: "mouseWheel", x: 100, y: 200, deltaY: -300, deltaX: 0 });
      }, testUrl);
      await expect
        .poll(async () =>
          z.number().parse(
            await app?.evaluate(
              ({ webContents }, pageUrl) =>
                webContents
                  .getAllWebContents()
                  .find((page) => page.getURL() === pageUrl)
                  ?.executeJavaScript("scrollY"),
              testUrl,
            ),
          ),
        )
        .toBeGreaterThan(0);
    } finally {
      await daemon.close();
      await app?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
