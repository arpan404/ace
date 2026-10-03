import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm, cp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
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
