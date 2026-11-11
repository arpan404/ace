import { existsSync } from "node:fs";
import { copyFile, mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
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
import { SpadeMaintenance, type SpadeSwapPorts } from "./spade-swap.ts";

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
  const dataDir = join(home, "spade");
  const database = join(dataDir, "spade.sqlite");
  const snapshotDir = join(home, ".spade-update-snapshot");
  const checkDir = join(home, ".spade-migration-check");
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
    async restoreDatabase(snapshot) {
      for (const suffix of ["", "-wal", "-shm"]) await rm(database + suffix, { force: true });
      await copyFile(snapshot, database);
      await flush(database);
    },
    async removeSnapshot() {
      await rm(snapshotDir, { recursive: true, force: true });
    },
    flip: (target) => flipSpadeCurrent(home, target),
    async serverPid() {
      return (await endpoint().catch(() => undefined))?.pid;
    },
    stop: () => stopSpadeService(plan, service),
    restart: () => restartSpadeService(plan, service),
    async health(target, oldPid) {
      // A restart writes a new token, port and pid, so all three are read again on every try.
      for (let attempt = 0; attempt < 60; attempt++) {
        try {
          const { connection, pid } = await endpoint();
          if (pid !== oldPid) {
            const health = await proven(connection);
            if (health?.version === target) return true;
          }
        } catch {}
        await service.wait(500);
      }
      return false;
    },
    wait: (ms) => service.wait(ms),
    now: io.now ?? Date.now,
  };
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
