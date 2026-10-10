import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { electronBinary, repo, appEnvironment } from "../scripts/common.ts";

// A standalone Electron process avoids Playwright attaching a CDP client to the renderer
// being killed. It drives the real crash event, reload, cookie store and debugger attachment.
it.runIf(process.env.ACE_E2E_ELECTRON === "1")(
  "a crashed native renderer reloads its signed-in page in the same view",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ace-browser-crash-"));
    const server = createServer((_req, res) =>
      res.end("<!doctype html><title>Crash fixture</title><p>Retained page</p>"),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const script = join(root, "main.cjs");
    try {
      await build({
        stdin: {
          contents: `
        import { app, BaseWindow, WebContentsView, session } from 'electron';
        import { EmbeddedViews } from ${JSON.stringify(join(repo, "apps/desktop/src/main/browser/views.ts"))};
        import assert from 'node:assert/strict';
        import { EmbeddedPage } from ${JSON.stringify(join(repo, "apps/desktop/src/main/browser/page.ts"))};
        (async () => { app.setPath('userData', ${JSON.stringify(join(root, "userData"))});
        await app.whenReady();
        const window = new BaseWindow({show:false});
        const owned = session.fromPartition('persist:crash-fixture');
        const view = new WebContentsView({webPreferences:{session:owned,sandbox:true,contextIsolation:true,nodeIntegration:false}});
        window.contentView.addChildView(view);
        const page = new EmbeddedPage({view, session:owned, released:undefined, window, park:()=>window, platform:process.platform, log:console.error, forward:()=>{}, forget:()=>{}});
        try {
          await page.prepare({width:800,height:600});
          await page.navigate(${JSON.stringify(`http://127.0.0.1:${address.port}/`)}, 10000);
          await view.webContents.executeJavaScript("document.cookie='signin=retained;path=/'");
          const restarted = new Promise((resolve,reject)=>page.onEvent((method)=>{
            if(method==='ace.rendererRestarted') page.cdp('ace.rendererReady').then(resolve,reject);
            if(method==='Inspector.detached') reject(new Error('View lost instead of reloaded'));
          }));
          view.webContents.forcefullyCrashRenderer();
          await restarted;
          assert.equal(await view.webContents.executeJavaScript('document.cookie'), 'signin=retained');
          assert.equal(await view.webContents.executeJavaScript('document.title'), 'Crash fixture');
          assert.equal(view.webContents.debugger.isAttached(), true);
          console.log('CRASH_RECOVERED');
          await page.close();
          const host = new EmbeddedViews({window:()=>window,partitionsDir:${JSON.stringify(join(root, "userData", "Partitions"))},platform:process.platform,log:console.error});
          const open = threadId => host.open({sessionId:threadId, options:{threadId,workspaceId:'workspace',profile:'persistent'},viewport:{width:800,height:600}});
          for(let i=0;i<32;i++) await (await open('thread-'+i)).close();
          await assert.rejects(open('thread-32'), /profile limit/);
          await (await open('thread-0')).close();
          console.log('PARTITIONS_BOUNDED');
        } finally { await page.close(); window.destroy(); app.quit(); }
        })().catch(error=>{console.error(error);app.exit(1)});
      `,
          resolveDir: repo,
          sourcefile: "browser-crash-fixture.ts",
          loader: "ts",
        },
        outfile: script,
        bundle: true,
        format: "cjs",
        platform: "node",
        external: ["electron"],
      });
      const child = spawn(await electronBinary(), [script], {
        env: { ...appEnvironment(process.env), HOME: root, ACE_HOME: join(root, "ace") },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout?.on("data", (bytes: Buffer) => {
        output = (output + bytes.toString()).slice(-16000);
      });
      child.stderr?.on("data", (bytes: Buffer) => {
        output = (output + bytes.toString()).slice(-16000);
      });
      const exit = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      expect(output).toContain("CRASH_RECOVERED");
      expect(output).toContain("PARTITIONS_BOUNDED");
      expect(exit).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
