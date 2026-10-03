import { spawn } from "node:child_process";
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
async function launch(root: string, providerHome: string) {
  const home = join(root, "ace");
  const began = performance.now();
  const child = spawn(
    process.execPath,
    [
      "--import",
      new URL("./history-memory.fixture.ts", import.meta.url).href,
      fileURLToPath(new URL("./cli.ts", import.meta.url)),
      "start",
    ],
    {
      env: {
        ...process.env,
        ACE_HOME: home,
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
  child.on("message", (value: unknown) => {
    const sample = z.object({ type: z.literal("rss"), bytes: z.number().positive() }).parse(value);
    memory.push(sample.bytes);
  });
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
  return { child, exited, client, origin, token, elapsed: performance.now() - began, memory };
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

it("a daemon serves requests and creates every feature store while thousands of native sessions are still indexing", async () => {
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
  for (const name of ["models.sqlite", "notifications.sqlite", "usage.sqlite"])
    expect((await readFile(join(history.root, "ace", name))).length).toBeGreaterThan(0);
  await stop(daemon);
}, 30_000);

it("restarting serves the saved index during a scan and reads only new or changed native files", async () => {
  const history = await nativeHistory();
  const first = await launch(history.root, history.providerHome);
  const baseline = first.memory.at(-1) ?? 0;
  const observedAt = first.memory.length;
  const initial = await completed(first.client);
  expect(baseline).toBeGreaterThan(0);
  const later = first.memory.slice(observedAt);
  expect(later.length).toBeGreaterThan(2);
  expect(Math.max(...later) - baseline).toBeLessThan(160 * 1024 * 1024);
  expect(initial.stats).toMatchObject({ files: count, reads: count, skipped: 0 });
  // Sampling eight 64 MiB files must remain bounded to head/tail windows.
  expect(initial.stats.bytes).toBeLessThan(count * 128 * 1024);
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
  const daemon = await launch(root, providerHome);
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
