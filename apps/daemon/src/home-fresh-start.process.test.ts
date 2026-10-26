import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { BACKUP_README, HOME_FORMAT_FILE, HOME_FORMAT_VERSION, serviceCommand } from "@ace/service";
import { exitCodes } from "./cli/output.ts";
import { daemonLogRecords } from "./daemon-log-test-support.ts";
import { readConfig, startDaemon } from "./index.ts";
import { daemonCli, launchDaemon } from "./process-test-support.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** A temporary user home; the daemon's `.ace` and its backups live here, never in the real one. */
async function userHome(prefix: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  return home;
}

/** The pre-format `~/.ace`: a launcher that records being run, daemon data and worktrees. */
async function legacyHome(home: string): Promise<string> {
  const root = join(home, ".ace");
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(join(root, "bin", "ace"), `#!/bin/sh\necho ran > "${join(home, "ran")}"\n`, {
    mode: 0o755,
  });
  await mkdir(join(root, "daemon"));
  await writeFile(join(root, "daemon", "state.sqlite"), "legacy state");
  await mkdir(join(root, "worktrees"));
  return root;
}

const daemonEnv = (home: string) => ({
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
});

/** `ace start` that is expected to refuse: its exit code and stderr. */
async function refusedStart(home: string): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [daemonCli(), "start"], {
    env: daemonEnv(home),
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
  return { code, stderr };
}

async function eventually<T>(read: () => Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await read().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting");
}

test("daemon logs land in the new home after a fresh start, and the backup is logged", async () => {
  const home = await userHome("ace-fresh-logs-");
  const root = await legacyHome(home);
  const daemon = await startDaemon({
    config: readConfig({ ACE_PORT: "0", ACE_LOG_LEVEL: "info" }, home),
    modelInstances: [],
    history: { instances: [] },
  });
  cleanups.push(() => daemon.close());
  const backup = join(home, ".ace-v0");

  const record = await eventually(async () =>
    (await daemonLogRecords(root)).find((entry) =>
      entry.message.startsWith("Started with a fresh"),
    ),
  );
  expect(record).toMatchObject({
    level: "info",
    data: { previousFormat: "ace-v0", bytes: expect.any(Number) },
  });
  expect(String(record.data?.backup)).toMatch(/\.ace-v0$/);
  // The daemon runs in the new home; the old one keeps its data and gains only the README.
  expect(daemon.tokenPath).toBe(join(root, "daemon-token"));
  expect(JSON.parse(await readFile(join(root, HOME_FORMAT_FILE), "utf8"))).toMatchObject({
    format: `ace-v${HOME_FORMAT_VERSION}`,
  });
  expect((await readdir(backup)).toSorted()).toEqual(
    [BACKUP_README, "bin", "daemon", "worktrees"].toSorted(),
  );
  await expect(readdir(join(backup, "logs"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(home, "ran"))).rejects.toMatchObject({ code: "ENOENT" });
}, 60_000);

test("a newer-format home refuses with 65 and is not renamed", async () => {
  const parent = await userHome("ace-newer-format-");
  const home = join(parent, "ace-data");
  await mkdir(home);
  const newer = `ace-v${HOME_FORMAT_VERSION + 1}`;
  const marker = JSON.stringify({ format: newer, createdAt: "2027-01-01T00:00:00.000Z" });
  await writeFile(join(home, HOME_FORMAT_FILE), marker);

  const { code, stderr } = await refusedStart(home);

  const message = `data format ${newer}, build supports ace-v${HOME_FORMAT_VERSION}. Open the newest ace or update this one.`;
  expect(code).toBe(exitCodes["newer-data"]);
  expect(code).toBe(65);
  expect(stderr).toContain("This ace build is older than the data in");
  expect(stderr).toContain(message);
  const records = await daemonLogRecords(home);
  expect(records).toContainEqual(
    expect.objectContaining({
      level: "error",
      message: expect.stringContaining(message),
      data: expect.objectContaining({ storedFormat: newer }),
    }),
  );
  expect(records.map((record) => record.message)).not.toContain("Daemon listening");
  expect(await readdir(parent)).toEqual(["ace-data"]);
  const files = await readdir(home);
  expect(files.filter((name) => /\.sqlite/.test(name))).toEqual([]);
  expect(files).not.toContain("daemon-endpoint");
  // The newer format is never overwritten by the older build.
  expect(await readFile(join(home, HOME_FORMAT_FILE), "utf8")).toBe(marker);
}, 60_000);

test("a home whose old daemon is still running is not renamed", async () => {
  const parent = await userHome("ace-live-old-daemon-");
  const home = join(parent, "ace-data");
  const old = launchDaemon(daemonEnv(home), /Token file:/, cleanups);
  await old.ready;
  // The old daemon recovers transfers in the background after it listens; let that settle so
  // the snapshot below holds only what the refused start could have changed.
  await expect.poll(() => readdir(home), { timeout: 30_000 }).toContain("transfers");
  // The running daemon's home now reads as an older format, as after this build's format bump.
  await writeFile(
    join(home, HOME_FORMAT_FILE),
    JSON.stringify({ format: "ace-v0", createdAt: "2026-01-01T00:00:00.000Z" }),
  );
  const before = (await readdir(home)).toSorted();

  const { code, stderr } = await refusedStart(home);

  expect(code).toBe(exitCodes.failed);
  expect(stderr).toContain(`an older ace daemon (pid ${old.child.pid}) is still using it`);
  expect(stderr).toContain("Nothing was moved.");
  expect(await readdir(parent)).toEqual(["ace-data"]);
  expect((await readdir(home)).toSorted()).toEqual(before);
  // The old daemon keeps serving from where it was.
  expect(old.child.exitCode).toBeNull();
  old.child.kill("SIGTERM");
  expect((await old.exited)[0]).toBe(0);
}, 90_000);

test("~/.ace-next from interim builds is never read, moved or written", async () => {
  const home = await userHome("ace-interim-home-");
  const interim = join(home, ".ace-next");
  await mkdir(interim);
  await writeFile(join(interim, "events.sqlite"), "interim threads");
  await writeFile(join(interim, "legacy-home.json"), "{}");
  const daemon = await startDaemon({
    config: readConfig({ ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }, home),
    modelInstances: [],
    history: { instances: [] },
  });
  cleanups.push(() => daemon.close());

  expect(daemon.tokenPath).toBe(join(home, ".ace", "daemon-token"));
  expect((await readdir(home)).toSorted()).toEqual([".ace", ".ace-next"]);
  expect((await readdir(interim)).toSorted()).toEqual(["events.sqlite", "legacy-home.json"]);
  expect(await readFile(join(interim, "events.sqlite"), "utf8")).toBe("interim threads");
}, 60_000);

test("a service command sets a legacy home aside instead of registering or running its launcher", async () => {
  const home = await userHome("ace-legacy-service-");
  const root = await legacyHome(home);

  await expect(serviceCommand(root, ["install"])).rejects.toThrow(/Install a daemon artifact/);

  await expect(readFile(join(home, "ran"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(home, ".ace-v0", "daemon", "state.sqlite"), "utf8")).toBe(
    "legacy state",
  );
  expect(await readdir(root)).toEqual([HOME_FORMAT_FILE]);
});
