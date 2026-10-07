import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm, cp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { checked, runProcess } from "@ace/service";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { extract } from "tar";
import { z } from "zod";
import { Store, createDevThread } from "@ace/daemon";
import { once } from "node:events";
import { generateKeyPairSync } from "node:crypto";
import { bundleDaemon } from "@ace/release";
import { ServerMessage, NotificationDevice } from "@ace/protocol";
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
test(
  "the standalone daemon persists notifications, structured logs and exported diagnostics without a checkout",
  { timeout: 60_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ace-bundle-"));
    roots.push(root);
    const emptyPath = join(root, "empty-bin");
    await mkdir(emptyPath);
    const publicKey = generateKeyPairSync("ed25519")
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
    await bundleDaemon(resolve(import.meta.dirname, "../../.."), root, publicKey);
    // Use only the packaged SDK and its local store; no auth or provider turn is started.
    const runtimeCheckpoint = await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
import { SqliteLocalAgentStore } from '@cursor/sdk/sqlite';
import sharp from 'sharp';
const encodedImage = await sharp({create:{width:320,height:240,channels:4,background:{r:230,g:40,b:70,alpha:0.5}}}).png().toBuffer();
const preview = await sharp(encodedImage).resize({width:256,height:256,fit:'inside'}).png().toBuffer();
const info = await sharp(preview).metadata();
if(info.width!==256 || info.height!==192 || !info.hasAlpha) throw new Error('Packaged attachment decoder lost image dimensions or alpha');
import { createRequire } from 'node:module';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
const resolveSdk = createRequire(createRequire(import.meta.url).resolve('@cursor/sdk')).resolve;
await access(join(dirname(resolveSdk('@cursor/sdk-${process.platform}-${process.arch}/package.json')),'bin','rg'), constants.X_OK);
const options = {stateRoot:join(process.cwd(),'offline-sdk-state'),workspaceRef:process.cwd()};
let store = await SqliteLocalAgentStore.open(options);
try {
  const blobId = 'ab'.repeat(32);
  await store.agents.create({agent:{agentId:'offline',cwd:process.cwd(),status:'idle',createdAt:1,updatedAt:1}});
  await store.checkpoints.create({agentId:'offline',blobId,data:new Uint8Array([1,2,3])});
  await store.dispose();
  store = await SqliteLocalAgentStore.open(options);
  console.log(JSON.stringify(Array.from(await store.checkpoints.get({agentId:'offline',blobId}))));
} catch (error) {console.error(error.message);process.exitCode=1;} finally {await store.dispose();}
`,
      ],
      { cwd: root, env: { HOME: root, PATH: emptyPath }, maxBuffer: 65536 },
    );
    expect(JSON.parse(runtimeCheckpoint.stdout)).toEqual([1, 2, 3]);
    // Caller instrumentation can depend on the checkout and must not reach the artifact.
    const bootstrap = join(root, "host-only-bootstrap.mjs");
    await writeFile(
      bootstrap,
      'import { isMainThread } from "node:worker_threads"; if (!isMainThread && process.argv[1]?.endsWith("/usage-worker.mjs")) throw new Error("Host-only worker instrumentation");',
    );
    vi.stubEnv("NODE_OPTIONS", `--import=${pathToFileURL(bootstrap).href}`);
    const child = spawn(process.execPath, [join(root, "ace.mjs"), "start"], {
      cwd: root,
      env: {
        HOME: root,
        PATH: emptyPath,
        TZ: "UTC",
        ACE_HOME: join(root, "data"),
        ACE_PORT: "0",
        ACE_LISTEN: "local",
        ACE_MODEL_INSTANCES: "[]",
        ACE_VERSION: "1.2.3",
        ACE_DEV: "0",
        ACE_HISTORY_INSTANCES: "[]",
        ACE_MAINTENANCE: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    vi.unstubAllEnvs();
    let output = "",
      errors = "";
    child.stderr.on("data", (chunk: Buffer) => {
      errors = (errors + chunk.toString()).slice(-65536);
    });
    try {
      await new Promise<void>((ready, reject) => {
        child.stdout.on("data", (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-65536);
          if (output.includes("Token file:")) ready();
        });
        child.once("error", reject);
        child.once("close", () => reject(new Error(errors)));
      });
      const endpoint = await readFile(join(root, "data/daemon-endpoint"), "utf8"),
        token = await readFile(join(root, "data/daemon-token"), "utf8");
      const response = await fetch(endpoint + "/v1/status", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(await response.json()).toMatchObject({ running: true, version: "1.2.3" });
      const socket = new WebSocket(endpoint.replace("http:", "ws:"));
      try {
        await new Promise<void>((ready, reject) => {
          socket.addEventListener(
            "open",
            () =>
              socket.send(
                JSON.stringify({
                  type: "hello",
                  protocolVersion: 1,
                  deviceId: "bundle-host",
                  token,
                }),
              ),
            { once: true },
          );
          socket.addEventListener("error", () => reject(new Error("Bundled WebSocket failed")), {
            once: true,
          });
          socket.addEventListener("close", () => reject(new Error("Bundled WebSocket closed")), {
            once: true,
          });
          socket.addEventListener("message", (event) => {
            try {
              const frame = ServerMessage.parse(JSON.parse(String(event.data)));
              if (frame.type === "welcome")
                socket.send(
                  JSON.stringify({
                    type: "usage.summary",
                    requestId: "bundled-usage",
                    query: { from: "2026-10-01", to: "2026-10-02" },
                  }),
                );
              else if (frame.type === "usage.result") {
                expect(frame).toMatchObject({
                  requestId: "bundled-usage",
                  kind: "summary",
                  result: {
                    timezone: "UTC",
                    rows: [
                      {
                        dimensions: {},
                        totals: { inputTokens: 0, outputTokens: 0, providerReportedUsd: 0 },
                      },
                    ],
                  },
                });
                ready();
              } else if (frame.type === "error") reject(new Error(frame.message));
            } catch (error) {
              reject(error);
            }
          });
        });
      } finally {
        const closed = new Promise<void>((closedReady) =>
          socket.addEventListener("close", () => closedReady(), { once: true }),
        );
        socket.close();
        await closed;
      }
      const exit = once(child, "exit");
      child.kill("SIGTERM");
      expect((await exit)[0]).toBe(0);
      const persisted = new DatabaseSync(join(root, "data/notifications.sqlite"), {
        readOnly: true,
      });
      try {
        const row = persisted
          .prepare("SELECT body FROM devices WHERE id=? AND revoked=0")
          .get("bundle-host");
        if (typeof row?.body !== "string")
          throw new Error("Notification worker did not persist the host device");
        expect(NotificationDevice.parse(JSON.parse(row.body))).toMatchObject({
          id: "bundle-host",
          address: { channel: "websocket", platform: "web" },
        });
      } finally {
        persisted.close();
      }
      const records = (await readFile(join(root, "data/logs/ace.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => z.object({ message: z.string() }).parse(JSON.parse(line)));
      expect(records.some((record) => record.message === "Daemon listening")).toBe(true);
      const store = new Store(join(root, "data/events.sqlite"));
      try {
        createDevThread(store, store.createWorkspace(root, "Bundle fixture"));
      } finally {
        store.close();
      }
      const support = join(root, "support.tar.gz");
      await promisify(execFile)(
        process.execPath,
        [join(root, "ace.mjs"), "support-bundle", support, "--include-threads"],
        {
          cwd: root,
          env: {
            HOME: root,
            PATH: emptyPath,
            ACE_HOME: join(root, "data"),
            ACE_PORT: "0",
            ACE_LISTEN: "local",
          },
          maxBuffer: 65536,
        },
      );
      const exported = join(root, "exported");
      await mkdir(exported);
      await extract({ file: support, cwd: exported });
      const report = z
        .object({ checks: z.array(z.object({ id: z.string(), status: z.string() })) })
        .parse(JSON.parse(await readFile(join(exported, "doctor.json"), "utf8")));
      expect(report.checks.find((check) => check.id === "sqlite")?.status).toBe("ok");
      const events = (await readFile(join(exported, "threads.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => z.object({ type: z.string() }).parse(JSON.parse(line)));
      expect(events.some((event) => event.type === "thread.created")).toBe(true);
      const copy = join(root, "migration-copy");
      await cp(join(root, "data"), copy, { recursive: true });
      await checked(runProcess, process.execPath, [join(root, "ace.mjs"), "migrate-check", copy]);
      const db = new DatabaseSync(join(copy, "events.sqlite"));
      db.exec("UPDATE schema_version SET version = 999");
      db.close();
      await expect(
        checked(runProcess, process.execPath, [join(root, "ace.mjs"), "migrate-check", copy]),
      ).rejects.toThrow("newer");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, "exit");
        child.kill("SIGKILL");
        await exit;
      }
    }
  },
);

test.each([
  [
    "tgz",
    "H4sIAPSExWoC/+3NMQrCQBQE0K09RY7wCcacZxMWDUgKswG9vSGNhbUi+F4zwzSTz2Wu6bNi00fsGe8Z0Xavvu+nvjumJtIXrEvNt+0y/aflMddLqdPYlHsZ15qHazkkAAAAAAAAAAAAft0TWUWJbgAoAAA=",
  ],
  [
    "zip",
    "UEsDBBQAAAAAAAKURl15p1flFQAAABUAAAAFAAAAYWdlbnRzeW50aGV0aWMgZXhlY3V0YWJsZQpQSwECFAMUAAAAAAAClEZdeadX5RUAAAAVAAAABQAAAAAAAAAAAAAAgAEAAAAAYWdlbnRQSwUGAAAAAAEAAQAzAAAAOAAAAAAA",
  ],
])(
  "the standalone registry installs an approved %s archive on first use without a checkout",
  { timeout: 60_000 },
  async (extension, encoded) => {
    const root = await mkdtemp(join(tmpdir(), "ace-lazy-archive-bundle-"));
    roots.push(root);
    const resolveDaemon = createRequire(createRequire(import.meta.url).resolve("@ace/daemon"));
    const registry = resolveDaemon.resolve("@ace/agent-registry");
    const entry = join(root, "fixture.ts");
    // Tiny archives created for this test; installing only hashes the fake executable.
    await writeFile(
      entry,
      `
import {AgentCatalog,AgentRegistry,fileCache,fileInventoryStorage,digest} from ${JSON.stringify(registry)};
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
const root=process.cwd(), bytes=Buffer.from(${JSON.stringify(encoded)},'base64');
let id=0;
const agent={id:'sample',name:'Sample',version:'1.0.0',description:'Synthetic',license_url:'https://example.org/license',distribution:{binary:{'linux-x86_64':{archive:'https://example.org/agent.${extension}',cmd:'agent',args:[],env:{},sha256:digest(bytes)}}}};
const catalog=await AgentCatalog.open({cache:fileCache(join(root,'snapshot.json'),()=>String(++id)),now:()=>1000,target:'linux-x86_64',fetch:async()=>new Response(JSON.stringify({version:'1.0.0',agents:[agent]}))});
const service=await AgentRegistry.open({catalog,root:join(root,'installations'),target:'linux-x86_64',env:{HOME:root,PATH:''},storage:fileInventoryStorage(join(root,'inventory.json'),()=>String(++id)),runtime:{fetch:async()=>new Response(bytes)}});
try {
 await catalog.refresh();
 const preview=await service.handle({type:'registry.install-plan',requestId:'plan',acpAgentId:'official:sample',runtime:'binary'});
 if(!preview.result.ok||!('plan' in preview.result)) throw new Error('No installation plan');
 const reply=await service.handle({type:'registry.install-intent',requestId:'install',intentId:'approved',digest:preview.result.plan.digest});
 if(!reply.result.ok||!('installation' in reply.result)) throw new Error(JSON.stringify(reply.result));
 const plan=await service.resolve(reply.result.installation);
 console.log(JSON.stringify({content:await readFile(plan.command,'utf8')}));
} catch(error) {console.error(error instanceof Error?error.message:'Registry fixture failed');process.exitCode=1;} finally {await service.close();}
`,
    );
    await bundleDaemon(resolve(import.meta.dirname, "../../.."), root, "", undefined, entry);
    await rm(entry);
    const result = await promisify(execFile)(process.execPath, [join(root, "ace.mjs")], {
      cwd: root,
      env: { HOME: root, PATH: "" },
      maxBuffer: 65536,
    });
    expect(JSON.parse(result.stdout)).toEqual({ content: "synthetic executable\n" });
  },
);

test(
  "the packaged MCP listener serves its first tool call and persists its effect without a checkout",
  { timeout: 60_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ace-lazy-mcp-bundle-"));
    roots.push(root);
    const resolveDaemon = createRequire(createRequire(import.meta.url).resolve("@ace/daemon"));
    const mcp = resolveDaemon.resolve("@ace/mcp-server");
    const client = createRequire(mcp)
      .resolve("@modelcontextprotocol/client")
      .replace(/\.cjs$/, ".mjs");
    const zod = resolveDaemon.resolve("zod");
    const entry = join(root, "fixture.ts");
    await writeFile(
      entry,
      `
import { writeFileSync } from "node:fs";
import { CredentialRegistry, ToolRegistry, nodeScheduler, startMcpServer } from ${JSON.stringify(mcp)};
import { z } from ${JSON.stringify(zod)};
const registry = new ToolRegistry({scheduler:nodeScheduler});
registry.register({name:"ace_echo",description:"Echo",input:z.object({value:z.string()}),output:z.object({value:z.string()}),capability:null,timeoutMs:1000,async run(value){writeFileSync("effect.json",JSON.stringify(value));return value;}});
const credentials = new CredentialRegistry(() => "a".repeat(64));
const server = await startMcpServer({registry,credentials});
const lease = credentials.issue({sessionId:"test",threadId:"thread",agentId:"agent",capabilities:[]},new AbortController().signal);
const { Client, StreamableHTTPClientTransport } = await import(${JSON.stringify(client)});
const client = new Client({name:"test",version:"1"},{versionNegotiation:{mode:{pin:"2026-07-28"}}});
try {
 await client.connect(new StreamableHTTPClientTransport(new URL(server.url),{requestInit:{headers:{Authorization:"Bearer "+lease.bearer}}}));
 const result = await client.callTool({name:"ace_echo",arguments:{value:"cold import"}});
 console.log(JSON.stringify(result.structuredContent));
} finally {await client.close();lease.end();await server.close();}
`,
    );
    await bundleDaemon(resolve(import.meta.dirname, "../../.."), root, "", undefined, entry);
    await rm(entry);
    const result = await promisify(execFile)(process.execPath, [join(root, "ace.mjs")], {
      cwd: root,
      env: { HOME: root, PATH: "" },
      timeout: 15_000,
      maxBuffer: 65536,
    });
    expect(JSON.parse(result.stdout)).toEqual({ value: "cold import" });
    expect(JSON.parse(await readFile(join(root, "effect.json"), "utf8"))).toEqual({
      value: "cold import",
    });
  },
);
