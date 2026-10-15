import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { exitCodes } from "./cli/output.ts";
import { daemonLogRecords } from "./daemon-log-test-support.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** Stores written by an older pre-release build, in the files the daemon owns. */
const stores = [
  {
    store: "notifications (listener phase)",
    file: "notifications.sqlite",
    write: (db: DatabaseSync) =>
      db.exec(
        "CREATE TABLE threads (id TEXT PRIMARY KEY, body TEXT NOT NULL); PRAGMA user_version=3",
      ),
    detail: "notification database is format 3",
  },
  {
    store: "forge links (core phase)",
    file: "events.sqlite",
    write: (db: DatabaseSync) =>
      db.exec("CREATE TABLE forge_links(thread_id TEXT PRIMARY KEY,payload TEXT NOT NULL)"),
    detail: "Pull request links are stored in an older format",
  },
];

test.each(stores)(
  "a daemon stops with one recovery message when $store data is in a format it cannot read",
  async ({ file, write, detail }) => {
    const home = await mkdtemp(join(tmpdir(), "ace-incompatible-"));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const path = join(home, file);
    const db = new DatabaseSync(path);
    write(db);
    db.close();
    const child = spawn(
      process.execPath,
      [new URL("./cli.ts", import.meta.url).pathname, "start"],
      {
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
      },
    );
    cleanups.push(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const [code] = (await once(child, "exit")) as [number | null];
    expect(code).toBe(exitCodes["incompatible-data"]);
    expect(stderr).toContain(detail);
    expect(stderr).toContain(path);
    const records = await daemonLogRecords(home);
    const failed = records.filter((record) => record.message === "Daemon startup failed");
    expect(failed).toHaveLength(1);
    expect(JSON.stringify(failed[0])).toContain(detail);
    // No dependent service is reported unavailable on account of the refused store.
    expect(JSON.stringify(records)).not.toContain("is unavailable");
    expect(await readdir(home)).not.toContain("daemon-endpoint");
    // The refused store is left as it was, for the person to keep or set aside.
    const after = new DatabaseSync(path, { readOnly: true });
    try {
      expect(
        after
          .prepare("SELECT name FROM sqlite_master WHERE name IN ('threads','forge_links')")
          .get()?.name,
      ).toBeDefined();
    } finally {
      after.close();
    }
  },
  60_000,
);
