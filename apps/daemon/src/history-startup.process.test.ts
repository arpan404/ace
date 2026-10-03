import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { DeviceId, type ServerMessage } from "@ace/protocol";
import { z } from "zod";
import { HistoryScanStatus } from "@ace/protocol/history";
import { accessRequest } from "./client-access.ts";
import { Client } from "./socket-test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
const count = 6000;
const cwd = "/synthetic/workspace";
function record(index: number, text = "history prompt") {
  return (
    JSON.stringify({
      type: "user",
      sessionId: `session-${index}`,
      cwd,
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: text },
    }) + "\n"
  );
}
async function nativeHistory() {
  const root = await mkdtemp(join(tmpdir(), "ace-history-startup-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const providerHome = join(root, "native");
  const directory = join(providerHome, "projects", "project");
  await mkdir(directory, { recursive: true });
  for (let start = 0; start < count; start += 32)
    await Promise.all(
      Array.from({ length: Math.min(32, count - start) }, (_, offset) => {
        const index = start + offset;
        return writeFile(join(directory, `${index}.jsonl`), record(index));
      }),
    );
  // Sparse 64 MiB sessions guard against full-file reads without large fixture buffers.
  for (let index = 0; index < 8; index++) {
    const file = await open(join(directory, `${index}.jsonl`), "r+");
    try {
      await file.write(record(index), 64 * 1024 * 1024);
    } finally {
      await file.close();
    }
  }
  return { root, providerHome, directory };
}
async function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Exceeded ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function next(client: Client, predicate: (message: ServerMessage) => boolean) {
  for (;;) {
    const message = await client.next();
    if (predicate(message)) return message;
  }
}
async function launch(
  root: string,
  providerHome: string,
  gate: "scanHeld" | "stdout" = "scanHeld",
) {
  const home = join(root, "ace");
  const began = performance.now();
  const child = spawn(
    process.execPath,
    [
      "--import",
      new URL("./startup-gates.fixture.ts", import.meta.url).href,
      fileURLToPath(new URL("./cli.ts", import.meta.url)),
      "start",
    ],
    {
      env: {
        ...process.env,
        ACE_HOME: home,
        ACE_TEST_HOLD_HISTORY: gate === "scanHeld" ? "1" : "0",
        ACE_PORT: "0",
        ACE_LISTEN: "local",
        ACE_ACCOUNTS_DB: join(home, "accounts.sqlite"),
        ACE_DEV: "0",
        ACE_LOG_LEVEL: "silent",
        ACE_MAINTENANCE: "0",
        ACE_MODEL_INSTANCES: "[]",
        ACE_RELAY_URL: undefined,
        ACE_SCREEN_HELPER: undefined,
        ACE_APNS_KEY_FILE: "",
        ACE_VAPID_KEY_FILE: "",
        ACE_WORKSPACE_ROOT: "",
        PATH: "",
        ACE_HISTORY_INSTANCES: JSON.stringify([
          { id: "synthetic", provider: "claude", homeDir: providerHome },
        ]),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  const exited = once(child, "close");
  const memory: number[] = [];
  const held = Promise.withResolvers<void>();
  child.on("message", (value: unknown) => {
    const sample = z
      .object({ type: z.enum(["rss", "scanHeld"]), bytes: z.number().positive() })
      .parse(value);
    memory.push(sample.bytes);
    if (sample.type === "scanHeld") held.resolve();
  });
  const sample = async () => {
    const response = once(child, "message");
    child.send("sample-rss");
    const [value] = await response;
    return z.object({ type: z.literal("rss"), bytes: z.number().positive() }).parse(value).bytes;
  };
  let errors = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  let output = "";
  await bounded(
    new Promise<void>((resolve, reject) => {
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (/ace daemon: ws:\/\/127\.0\.0\.1:\d+\n/.test(output)) resolve();
      });
      void exited.then(() => reject(new Error(`Daemon exited: ${errors}`)));
    }),
    8000,
  );
  if (gate === "scanHeld") await bounded(held.promise, 1000);
  const origin = await readFile(join(home, "daemon-endpoint"), "utf8");
  const token = await readFile(join(home, "daemon-token"), "utf8");
  const client = new Client(origin.replace("http:", "ws:"));
  cleanups.push(() => client.close());
  await bounded(once(client.socket, "open"), 1000);
  client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("history-startup"),
    token,
  });
  await bounded(
    next(client, (message) => message.type === "welcome"),
    1000,
  );
  return {
    child,
    exited,
    client,
    origin,
    token,
    elapsed: performance.now() - began,
    memory,
    sample,
  };
}
async function status(client: Client) {
  client.send({ type: "history.scan", action: "status", requestId: "scan-status" });
  const reply = await bounded(
    next(
      client,
      (message) => message.type === "history.scan" && message.requestId === "scan-status",
    ),
    1000,
  );
  if (reply.type !== "history.scan") throw new Error("Missing history scan response");
  return HistoryScanStatus.parse(reply.scan);
}
async function completed(client: Client) {
  const scan = await status(client);
  if (scan.state === "ready") return scan;
  const event = await bounded(
    next(
      client,
      (message) => message.type === "history.scan.updated" && message.scan.state !== "scanning",
    ),
    120_000,
  );
  if (event.type !== "history.scan.updated") throw new Error("Missing progress event");
  expect(event.scan.state).toBe("ready");
  return event.scan;
}
async function stop(daemon: Awaited<ReturnType<typeof launch>>) {
  daemon.child.kill("SIGTERM");
  const [code, signal] = await bounded(daemon.exited, 2000);
  expect({ code, signal }).toEqual({ code: 0, signal: null });
}

it("a daemon serves history, models, notifications and usage requests while thousands of native sessions are still indexing", async () => {
  const history = await nativeHistory();
  const daemon = await launch(history.root, history.providerHome);
  expect(daemon.elapsed).toBeLessThan(8000);
  expect((await status(daemon.client)).state).toBe("scanning");
  daemon.client.send({ type: "history.list", cwd, requestId: "list", limit: 1 });
  const list = await bounded(
    next(
      daemon.client,
      (message) => message.type === "history.list" && message.requestId === "list",
    ),
    1000,
  );
  expect(list).toMatchObject({ type: "history.list", scan: { state: "scanning" } });
  const health = await bounded(
    accessRequest(daemon.origin, "/v1/status", { token: daemon.token }),
    1000,
  );
  expect(health).toMatchObject({
    running: true,
    services: expect.arrayContaining([{ name: "history", state: "starting" }]),
  });
  daemon.client.send({
    type: "models.list",
    requestId: "models",
    options: { offset: 0, limit: 100 },
  });
  const models = await bounded(
    next(daemon.client, (m) => m.type === "models.result" && m.requestId === "models"),
    1000,
  );
  expect(models).toMatchObject({
    type: "models.result",
    requestId: "models",
    result: { models: [], instances: [] },
  });
  daemon.client.send({
    type: "usage.summary",
    requestId: "usage",
    query: {
      from: "2026-01-01",
      to: "2026-01-01",
      groupBy: ["provider"],
      filters: {},
      limit: 100,
      orderBy: "tokens",
      equivalentApiCost: false,
    },
  });
  const usage = await bounded(
    next(daemon.client, (m) => m.type === "usage.result" && m.requestId === "usage"),
    1000,
  );
  expect(usage).toMatchObject({
    type: "usage.result",
    kind: "summary",
    result: { cursor: 0, rows: [], truncated: false },
  });
  daemon.client.send({
    type: "notification.register",
    device: { channel: "websocket", platform: "desktop" },
  });
  daemon.client.send({
    type: "notification.preferences",
    preferences: { includePreview: true, quietHours: null },
  });
  daemon.client.send({ type: "ping" });
  expect(
    await bounded(
      next(daemon.client, (m) => m.type !== "history.scan.updated"),
      1000,
    ),
  ).toEqual({ type: "pong" });
  // Observe the durable effect of these authenticated requests, not a schema file.
  const database = new DatabaseSync(join(history.root, "ace/notifications.sqlite"), {
    readOnly: true,
  });
  try {
    const row = database.prepare("SELECT body FROM devices WHERE id=?").get("history-startup");
    const body = z.string().parse(row?.body);
    expect(JSON.parse(body)).toMatchObject({
      id: "history-startup",
      preferences: { includePreview: true },
    });
  } finally {
    database.close();
  }
  await stop(daemon);
}, 30_000);

it("restarting serves the saved index during a scan and reads only new or changed native files", async () => {
  const history = await nativeHistory();
  const first = await launch(history.root, history.providerHome);
  const baseline = await first.sample();
  first.child.send("release-history");
  const initial = await completed(first.client);
  expect(baseline).toBeGreaterThan(0);
  const finalRss = await first.sample();
  expect(Math.max(finalRss, ...first.memory) - baseline).toBeLessThan(160 * 1024 * 1024);
  expect(initial.stats).toMatchObject({ files: count, reads: count, skipped: 0 });
  // Sampling eight 64 MiB files must remain bounded to head/tail windows.
  expect(initial.stats.bytes).toBeLessThanOrEqual(
    8 * 128 * 1024 + (count - 8) * Buffer.byteLength(record(count - 1)),
  );
  await stop(first);
  await writeFile(join(history.directory, "1.jsonl"), record(1, "changed history prompt"));
  await writeFile(join(history.directory, "added.jsonl"), record(count));
  const second = await launch(history.root, history.providerHome);
  second.client.send({ type: "history.list", cwd, requestId: "persisted", limit: 200 });
  const reply = await bounded(
    next(
      second.client,
      (message) => message.type === "history.list" && message.requestId === "persisted",
    ),
    1000,
  );
  expect(reply).toMatchObject({
    type: "history.list",
    scan: { state: "scanning" },
    sessions: expect.any(Array),
  });
  if (reply.type !== "history.list") throw new Error("Missing list response");
  expect(reply.sessions).toHaveLength(200);
  second.child.send("release-history");
  const rescanned = await completed(second.client);
  expect(rescanned.stats).toMatchObject({ files: count + 1, reads: 2, skipped: count - 1 });
  expect(rescanned.stats.bytes).toBeLessThan(256 * 1024);
  await stop(second);
}, 180_000);

it("shutdown cancels a running native scan and exits without waiting for the remaining history", async () => {
  const history = await nativeHistory();
  const daemon = await launch(history.root, history.providerHome);
  expect((await status(daemon.client)).state).toBe("scanning");
  await stop(daemon);
  await expect(readFile(join(history.root, "ace", "daemon-endpoint"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  // A leaked worker or lock must not keep the next process from opening the same home.
  const restarted = await launch(history.root, history.providerHome);
  expect((await status(restarted.client)).state).toBe("scanning");
  await stop(restarted);
}, 30_000);

it("an unreadable native inventory degrades history without withholding the daemon", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-history-failed-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const providerHome = join(root, "not-a-directory");
  await writeFile(providerHome, "not a provider directory");
  const daemon = await launch(root, providerHome, "stdout");
  let scan = await status(daemon.client);
  if (scan.state === "scanning") {
    const event = await bounded(
      next(
        daemon.client,
        (message) => message.type === "history.scan.updated" && message.scan.state === "failed",
      ),
      1000,
    );
    if (event.type !== "history.scan.updated") throw new Error("Missing scan failure");
    scan = event.scan;
  }
  expect(scan.state).toBe("failed");
  expect(scan.error).toContain("ENOTDIR");
  expect(await accessRequest(daemon.origin, "/v1/status", { token: daemon.token })).toMatchObject({
    running: true,
    services: expect.arrayContaining([
      expect.objectContaining({
        name: "history",
        state: "degraded",
        error: expect.stringContaining("history"),
      }),
    ]),
  });
  await stop(daemon);
}, 15_000);
