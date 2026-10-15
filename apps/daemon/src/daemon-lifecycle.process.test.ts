import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { accessRequest } from "./client-access.ts";
import { exitCodes } from "./cli/output.ts";
import { daemonLogRecords } from "./daemon-log-test-support.ts";
import { DATA_GENERATION, readConfig, startDaemon } from "./index.ts";
import { readShutdownReceipt } from "./shutdown-receipt.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
async function temporaryHome(prefix: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  return home;
}
test("a daemon refuses data written by a newer ace build before opening any database", async () => {
  const home = await temporaryHome("ace-newer-data-");
  await writeFile(
    join(home, "data-generation"),
    JSON.stringify({ generation: DATA_GENERATION + 1 }),
  );
  const child = spawn(process.execPath, [new URL("./cli.ts", import.meta.url).pathname, "start"], {
    env: {
      ...process.env,
      ACE_HOME: home,
      ACE_PORT: "0",
      ACE_LISTEN: "local",
      ACE_MAINTENANCE: "0",
      ACE_ACCOUNTS_DB: join(home, "accounts.sqlite"),
      ACE_DEV: "0",
      ACE_HISTORY_INSTANCES: "[]",
      ACE_MODEL_INSTANCES: "[]",
      ACE_WORKSPACE_ROOT: "",
      PATH: "",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  cleanups.push(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const [code] = (await once(child, "exit")) as [number | null];
  const message = `data generation ${DATA_GENERATION + 1}, build supports ${DATA_GENERATION}. Open the newest ace or update this one.`;
  expect(code).toBe(exitCodes["newer-data"]);
  expect(code).toBe(65);
  expect(stderr).toContain("This ace build is older than the data in");
  expect(stderr).toContain(message);
  const records = await daemonLogRecords(home);
  expect(records).toContainEqual(
    expect.objectContaining({
      level: "error",
      message: expect.stringContaining(message),
      data: expect.objectContaining({ storedGeneration: DATA_GENERATION + 1, pid: child.pid }),
    }),
  );
  expect(records.map((record) => record.message)).not.toContain("Daemon listening");
  const files = await readdir(home);
  expect(files.filter((name) => /\.sqlite/.test(name))).toEqual([]);
  expect(files).not.toContain("daemon-endpoint");
  // The newer generation is never overwritten by the older build.
  expect(JSON.parse(await readFile(join(home, "data-generation"), "utf8"))).toEqual({
    generation: DATA_GENERATION + 1,
  });
}, 60_000);

test("a daemon records the data generation it writes, so older builds can refuse it", async () => {
  const home = await temporaryHome("ace-data-generation-");
  const daemon = await startDaemon({ config: readConfig({ ACE_HOME: home, ACE_PORT: "0" }) });
  await daemon.close();
  expect(JSON.parse(await readFile(join(home, "data-generation"), "utf8"))).toEqual({
    generation: DATA_GENERATION,
  });
});

test("a stop request is logged with its own source, then the stop with its duration", async () => {
  const home = await temporaryHome("ace-stop-request-");
  const daemon = await startDaemon({ config: readConfig({ ACE_HOME: home, ACE_PORT: "0" }) });
  cleanups.push(() => daemon.close());
  const origin = await readFile(join(home, "daemon-endpoint"), "utf8");
  const token = await readFile(daemon.tokenPath, "utf8");
  const admission = (await accessRequest(origin, "/v1/stop", { method: "POST", token })) as {
    receiptId: string;
  };
  for (let attempt = 0; attempt < 200; attempt++) {
    const receipt = readShutdownReceipt(home);
    if (receipt?.id === admission.receiptId && receipt.state !== "pending") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(readShutdownReceipt(home)).toMatchObject({ state: "succeeded" });
  const records = await daemonLogRecords(home);
  const stopping = records.findIndex((record) => record.message === "Daemon stopping");
  expect(records[stopping]?.data).toMatchObject({ source: "stop-request", admission: "draining" });
  expect(records.at(-1)).toMatchObject({
    message: "Daemon stopped",
    data: { source: "stop-request", durationMs: expect.any(Number) },
  });
});

test("an event loop blocked for more than a second is recorded in the daemon log", async () => {
  const home = await temporaryHome("ace-loop-stall-");
  const daemon = await startDaemon({ config: readConfig({ ACE_HOME: home, ACE_PORT: "0" }) });
  cleanups.push(() => daemon.close());
  const until = performance.now() + 1_600;
  while (performance.now() < until);
  await new Promise((resolve) => setTimeout(resolve, 700));
  expect(daemon.eventLoop().maxDelayMs).toBeGreaterThanOrEqual(1_000);
  await daemon.close();
  expect(await daemonLogRecords(home)).toContainEqual(
    expect.objectContaining({
      level: "warn",
      message: "Event loop stalled",
      data: expect.objectContaining({ delayMs: expect.any(Number) }),
    }),
  );
});
