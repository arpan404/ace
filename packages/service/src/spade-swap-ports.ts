import { existsSync } from "node:fs";
import { copyFile, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { durableJson, durableRemove, syncDirectory } from "./files.ts";
import { DatabaseSync, backup } from "@ace/provider-kit/sqlite";
import { runProcess, type Runner } from "./process.ts";
import { spadeBinaryName, type SpadeServicePlan } from "./spade-plan.ts";
import { proveSpade, spadeRequest, type SpadeConnection } from "./spade/client.ts";
import { readSpadeServerFile, readSpadeTokenFile } from "./spade/endpoint.ts";
import { newSpadeNonce } from "./spade/proof.ts";
import { systemSpadePorts, type SpadeServicePorts } from "./spade-registration.ts";
import {
  flipSpadeCurrent,
  installedSpadeVersion,
  spadeReleases,
  stageSpadeBinary,
} from "./spade-release.ts";
import { restartSpadeService, spadeServiceState, stopSpadeService } from "./spade-service.ts";
import { SpadeMaintenance, SpadePendingSwap, type SpadeSwapPorts } from "./spade-swap.ts";

export interface SpadeSwapIo {
  home: string;
  plan: SpadeServicePlan;
  /** The new release's `spade-server`. */
  source: string;
  version: string;
  run?: Runner;
  service?: SpadeServicePorts;
  nonce?: () => string;
  now?: () => number;
}

/** The real ports: Spade's local HTTP API, its SQLite file, the new binary and the service. */
export function localSpadeSwapPorts(io: SpadeSwapIo): SpadeSwapPorts {
  const { home, plan, source, version } = io;
  const run = io.run ?? runProcess;
  const service = io.service ?? systemSpadePorts;
  const nonce = io.nonce ?? newSpadeNonce;
  const clock = io.now ?? Date.now;
  const dataDir = join(home, "spade");
  const database = join(dataDir, "spade.sqlite");
  const snapshotDir = join(home, ".spade-update-snapshot");
  const checkDir = join(home, ".spade-migration-check");
  const swapRecord = join(home, ".spade-update-swap.json");
  const keptPrefix = "spade.sqlite.";
  /** The record on disk, or undefined; throws when it can't be read or parsed. */
  const readRecord = async () => {
    if (!existsSync(swapRecord)) return undefined;
    return SwapRecord.parse(JSON.parse(await readFile(swapRecord, "utf8")));
  };
  /**
   * Moves `snapshot` beside the live database as `spade.sqlite.<label>`, out of the next
   * snapshot's way. The destination goes into the swap's record first, so a run that dies
   * mid-move is finished by the next one instead of failing it.
   */
  const protect = async (
    snapshot: string,
    label: string,
    record: z.infer<typeof SwapRecord> | undefined,
  ) => {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const kept = freeName(join(dataDir, `${keptPrefix}${label}`));
    if (record) await durableJson(swapRecord, { ...record, kept });
    await rename(snapshot, kept);
    await syncDirectory(dataDir);
    await rm(snapshotDir, { recursive: true, force: true });
    await syncDirectory(home);
    return kept;
  };
  /**
   * A record that can't be read says nothing worth trusting: it is set aside (never deleted),
   * any snapshot left on disk is protected from the next one, and the swap goes on from what is
   * installed and running.
   */
  const healUnreadable = async () => {
    // The snapshot first: once the record is gone, nothing else says the copy matters.
    await protectLeftover();
    await rename(swapRecord, freeNumbered(`${swapRecord}.unreadable`));
    await syncDirectory(home);
    return undefined;
  };
  /** A snapshot no active swap owns is moved to safety, never deleted. */
  const protectLeftover = async () => {
    const left = join(snapshotDir, "spade.sqlite");
    if (existsSync(left)) await protect(left, "before-unknown", undefined);
  };
  /** Where Spade says it listens (`server.json`) and the token it wrote, read afresh each time. */
  const endpoint = async () => {
    const server = readSpadeServerFile(await readFile(join(dataDir, "server.json"), "utf8"));
    if (!server.ok) throw new Error(`Spade's server.json is ${server.reason.replace("_", " ")}`);
    const token = readSpadeTokenFile(await readFile(join(dataDir, "token"), "utf8"));
    if (token === undefined) throw new Error("Spade's token file is unreadable");
    const { host, port, pid } = server.endpoint;
    const connection: SpadeConnection = { host, port, token };
    return { connection, pid };
  };
  const proven = (connection: SpadeConnection) =>
    proveSpade(connection, nonce(), AbortSignal.timeout(2_000));
  const request = async (method: string, path: string, body?: unknown) => {
    const { connection } = await endpoint();
    // The token goes only to the Spade that proves it already holds it.
    if (!(await proven(connection)))
      throw new Error(`The process at port ${connection.port} isn't Spade: no proof of its token`);
    const answer = await spadeRequest(
      connection,
      {
        method,
        path,
        ...(body === undefined ? {} : { body: Buffer.from(JSON.stringify(body)) }),
      },
      { signal: AbortSignal.timeout(10_000), maxBytes: 64 * 1024 },
    );
    if (answer.kind !== "response" || answer.status < 200 || answer.status > 299)
      throw new Error(
        `Spade answered ${answer.kind === "response" ? answer.status : "too much"} to ${method} ${path}`,
      );
    return answer.body.toString("utf8");
  };
  const status = async () =>
    SpadeMaintenance.parse(JSON.parse(await request("GET", "/v1/maintenance")));
  return {
    state: () => spadeServiceState(plan, service),
    installedVersion: () => installedSpadeVersion(home),
    async closeAdmission(mode, deadlineMs) {
      return SpadeMaintenance.parse(
        JSON.parse(await request("POST", "/v1/maintenance", { mode, deadline_ms: deadlineMs })),
      );
    },
    maintenance: status,
    async reopenAdmission() {
      await request("DELETE", "/v1/maintenance");
    },
    async stage() {
      await stageSpadeBinary(home, source, version);
    },
    async snapshot() {
      if (!existsSync(database)) return undefined;
      // A copy still here belongs to no swap in progress (theirs were kept or dropped by now).
      await protectLeftover();
      await rm(snapshotDir, { recursive: true, force: true });
      await mkdir(snapshotDir, { mode: 0o700 });
      const copy = join(snapshotDir, "spade.sqlite");
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        // One read snapshot, so Spade's writes can't restart the online backup forever.
        db.exec("BEGIN");
        db.prepare("SELECT count(*) FROM sqlite_schema").get();
        await backup(db, copy);
      } finally {
        if (db.isTransaction) db.exec("COMMIT");
        db.close();
      }
      await flush(copy);
      // Its directory entries reach the disk before a swap record can name the copy.
      await syncDirectory(snapshotDir);
      await syncDirectory(home);
      return copy;
    },
    async checkMigrations(snapshot) {
      // The check migrates the file it is given: it gets a copy, the snapshot stays as it was.
      await rm(checkDir, { recursive: true, force: true });
      await mkdir(checkDir, { mode: 0o700 });
      const copy = join(checkDir, "spade.sqlite");
      try {
        await copyFile(snapshot, copy);
        const binary = join(spadeReleases(home), version, spadeBinaryName(process.platform));
        const result = await run(binary, ["--check-migrations", copy]);
        if (result.code !== 0)
          throw new Error(
            (result.stderr.trim() || `--check-migrations exited ${result.code}`).slice(0, 1000),
          );
      } finally {
        await rm(checkDir, { recursive: true, force: true });
      }
    },
    async restoreDatabase(snapshot, failedVersion) {
      const live = existsSync(database) ? schemaOf(database) : undefined;
      if (live !== undefined && live <= schemaOf(snapshot)) return undefined;
      // Never deleted: the failed version's database, with what was stored during the swap.
      const aside = freeName(`${database}.failed-${failedVersion}`);
      for (const suffix of ["", "-wal", "-shm"])
        if (existsSync(database + suffix)) await rename(database + suffix, aside + suffix);
      await copyFile(snapshot, database);
      await flush(database);
      return aside;
    },
    async removeSnapshot() {
      await rm(snapshotDir, { recursive: true, force: true });
      await syncDirectory(home);
    },
    async keepSnapshot(snapshot, failedVersion) {
      // An earlier run may have moved it already and died before clearing the record.
      const record = await readRecord();
      if (snapshot === record?.kept) return snapshot;
      if (!existsSync(snapshot)) {
        if (record?.kept !== undefined && existsSync(record.kept)) return record.kept;
        throw new Error(`Spade's copy from before the swap is missing at ${snapshot}`);
      }
      return protect(snapshot, `before-${failedVersion}`, record);
    },
    async pendingSwap() {
      const record = await readRecord().catch(() => healUnreadable());
      if (!record) return undefined;
      // Already moved to safety, or already removed after a healthy finish: never a fatal ENOENT.
      const snapshot =
        record.snapshot !== undefined && existsSync(record.snapshot)
          ? record.snapshot
          : record.kept !== undefined && existsSync(record.kept)
            ? record.kept
            : undefined;
      return { from: record.from, to: record.to, snapshot };
    },
    async recordSwap(swap) {
      await durableJson(swapRecord, swap);
    },
    async clearSwap() {
      await durableRemove(swapRecord);
    },
    async pruneKeptSnapshots() {
      const record = await readRecord().catch(() => undefined);
      const needed = new Set([record?.snapshot, record?.kept]);
      const names = await readdir(dataDir).catch(() => [] as string[]);
      const kept: { path: string; at: number }[] = [];
      for (const name of names) {
        if (!name.startsWith(`${keptPrefix}before-`)) continue;
        const path = join(dataDir, name);
        kept.push({ path, at: (await stat(path)).mtimeMs });
      }
      kept.sort((a, b) => b.at - a.at);
      for (const { path } of kept.slice(keptSnapshots))
        if (!needed.has(path)) await rm(path, { force: true });
      await syncDirectory(dataDir).catch(() => {});
    },
    flip: (target) => flipSpadeCurrent(home, target),
    async serverPid() {
      return (await endpoint().catch(() => undefined))?.pid;
    },
    stop: () => stopSpadeService(plan, service),
    restart: () => restartSpadeService(plan, service),
    async runningVersion() {
      try {
        const { connection } = await endpoint();
        return (await proven(connection))?.version;
      } catch {
        return undefined;
      }
    },
    async health(target, oldPid) {
      // A first start migrates the real database before it writes server.json, which can take
      // a while: Spade gets minutes while the service says its process runs, and a short limit
      // once it has exited. A restart writes a new token, port and pid, so all three are read
      // again on every try.
      const started = clock();
      let seenRunning = started;
      for (;;) {
        try {
          const { connection, pid } = await endpoint();
          if (pid !== oldPid) {
            const health = await proven(connection);
            if (health?.version === target) return true;
          }
        } catch {}
        const at = clock();
        if (at - started >= spadeStartMs) return false;
        const state = await spadeServiceState(plan, service).catch(() => "stopped" as const);
        if (state === "running") seenRunning = at;
        else if (at - seenRunning >= spadeExitedMs) return false;
        await service.wait(500);
      }
    },
    wait: (ms) => service.wait(ms),
    now: clock,
  };
}

/** How long a new Spade may take to come up while its process runs, and once it has exited. */
export const spadeStartMs = 120_000;
export const spadeExitedMs = 10_000;

/** Spade's schema version (`PRAGMA user_version`) in the database at `path`. */
function schemaOf(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  } finally {
    db.close();
  }
}

/** The swap record on disk: the swap's fields, and where its snapshot was moved, once it was. */
const SwapRecord = SpadePendingSwap.extend({ kept: z.string().min(1).max(4096).optional() });

/** How many protected pre-swap copies are kept once a swap is verified healthy. */
export const keptSnapshots = 2;

/** `path-1`, `path-2`… : the first that's free. */
function freeNumbered(path: string): string {
  let n = 1;
  while (existsSync(`${path}-${n}`)) n++;
  return `${path}-${n}`;
}

/** `path`, or `path-2`, `path-3`… when an earlier rollback already used it. */
function freeName(path: string): string {
  let name = path;
  for (let n = 2; existsSync(name); n++) name = `${path}-${n}`;
  return name;
}

async function flush(path: string): Promise<void> {
  // Windows flushes only through a writable handle.
  const file = await open(path, process.platform === "win32" ? "r+" : "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
