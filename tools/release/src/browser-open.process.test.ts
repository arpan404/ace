import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { detectChromium } from "@ace/browser";
import { z } from "zod";
import { expect, it } from "vitest";
import { bundleDaemon } from "@ace/release";

it("packaged browser startup owns its guardian before entering the browser launcher", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-browser-bundle-"));
  const repo = resolve(import.meta.dirname, "../../..");
  const require = createRequire(import.meta.url);
  const browser = createRequire(require.resolve("@ace/daemon")).resolve("@ace/browser");
  const entry = join(root, "fixture.ts");
  // A launcher failure after guard startup proves the process edge worked. No browser or owner profile.
  await writeFile(
    entry,
    `
import { BrowserService } from ${JSON.stringify(browser)};
import { launchContext } from ${JSON.stringify(join(repo, "packages/browser/src/io.ts"))};
const service = new BrowserService({dataDir:process.cwd(),executablePath:"/missing-fixture-chromium",launchContext:async(profile,options)=>{
 try { await launchContext(profile,options); } catch(error) {
  if(error instanceof Error && error.message.toLowerCase().includes("executable doesn't exist")) throw new Error("fixture-launcher-reached");
  throw error;
 }
}});
try {await service.open({threadId:"thread",workspaceId:"workspace",background:true});} catch(error) {console.log(JSON.stringify({failure:error instanceof Error?error.message:"unknown"}));} finally {await service.close();}
`,
  );
  try {
    await bundleDaemon(repo, root, "", undefined, entry);
    await rm(entry);
    const result = await promisify(execFile)(process.execPath, [join(root, "ace.mjs")], {
      cwd: root,
      env: { PATH: "", HOME: root },
      timeout: 30_000,
      maxBuffer: 65536,
    });
    expect(z.object({ failure: z.string() }).parse(JSON.parse(result.stdout))).toEqual({
      failure: "fixture-launcher-reached",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

it("packaged ace_browser_open navigates and snapshots a local page in an isolated headless profile", async (context) => {
  const executable = await detectChromium();
  if (!executable) {
    context.skip("No fixture Chromium executable available");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "ace-browser-open-bundle-"));
  const repo = resolve(import.meta.dirname, "../../..");
  const require = createRequire(import.meta.url);
  const daemonRequire = createRequire(require.resolve("@ace/daemon"));
  const browser = daemonRequire.resolve("@ace/browser");
  const mcp = daemonRequire.resolve("@ace/mcp-server");
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end("<!doctype html><button>Fixture loaded</button>");
  });
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
  const entry = join(root, "fixture.ts");
  await writeFile(
    entry,
    `
import {BrowserService} from ${JSON.stringify(browser)};
import {ToolRegistry,CredentialRegistry} from ${JSON.stringify(mcp)};
import {Store} from ${JSON.stringify(join(repo, "apps/daemon/src/store.ts"))};
import {createDevThread} from ${JSON.stringify(join(repo, "apps/daemon/src/commands.ts"))};
import {browserToolkit} from ${JSON.stringify(join(repo, "apps/daemon/src/browser-toolkit.ts"))};
try {
const store=new Store("store.sqlite");
const workspace=store.createWorkspace(process.cwd(),"Fixture"),thread=createDevThread(store,workspace);
const service=new BrowserService({dataDir:process.cwd(),executablePath:process.env.FIXTURE_CHROMIUM});
const registry=new ToolRegistry({scheduler:{after:()=>()=>{}}});
browserToolkit(service,store).register(registry);
const credentials=new CredentialRegistry(()=>"a".repeat(64));
const lease=credentials.issue({sessionId:"mcp",threadId:thread.id,agentId:"agent",capabilities:["browser"]},new AbortController().signal);
try {
 const opened=[];
 for(let i=0;i<2;i++) opened.push(await registry.call("ace_browser_open",{url:process.env.FIXTURE_URL},lease.principal,new AbortController().signal));
 const snapshot=await registry.call("ace_browser_snapshot",{},lease.principal,new AbortController().signal);
 console.log(JSON.stringify({opened,snapshot,state:service.state(thread.id)}));
} finally {credentials.close();await service.close();store.close();}
} catch(error) { console.log(JSON.stringify({failure:error instanceof Error?error.message:"unknown fixture error"})); }
`,
  );
  try {
    await bundleDaemon(repo, root, "", undefined, entry);
    await rm(entry);
    const result = await promisify(execFile)(process.execPath, [join(root, "ace.mjs")], {
      cwd: root,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: root,
        FIXTURE_CHROMIUM: executable,
        FIXTURE_URL: `http://127.0.0.1:${address.port}`,
      },
      timeout: 60_000,
      maxBuffer: 65536,
    });
    const outcome = z
      .object({
        opened: z.array(z.object({ isError: z.boolean().optional() })),
        state: z.object({ backend: z.string(), status: z.string() }),
        snapshot: z.object({ content: z.array(z.object({ text: z.string() })) }),
      })
      .parse(JSON.parse(result.stdout));
    expect(outcome.opened).toHaveLength(2);
    for (const opened of outcome.opened) expect(opened.isError).not.toBe(true);
    expect(outcome.state).toMatchObject({ backend: "headless", status: "ready" });
    expect(outcome.snapshot.content).toMatchObject([
      { text: expect.stringContaining("Fixture loaded") },
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((accept) => server.close(() => accept()));
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
