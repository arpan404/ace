import { existsSync } from "node:fs";
import { copyFile, mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { DatabaseSync, backup } from "@ace/provider-kit/sqlite";
import { runProcess, type Runner } from "./process.ts";
import { spadeBinaryName, type SpadeServicePlan } from "./spade-plan.ts";
import { checkSpadeProof, newSpadeNonce } from "./spade-proof.ts";
import { systemSpadePorts, type SpadeServicePorts } from "./spade-registration.ts";
import {
  flipSpadeCurrent,
  installedSpadeVersion,
  spadeReleases,
  stageSpadeBinary,
} from "./spade-release.ts";
import { restartSpadeService, spadeServiceState, stopSpadeService } from "./spade-service.ts";
import { SpadeMaintenance, type SpadeSwapPorts } from "./spade-swap.ts";

/** Spade's `server.json`: where it listens and which process, written once it is ready. */
const SpadeServer = z.object({
  address: z.string().regex(/^127\.0\.0\.1:\d{1,5}$/),
  pid: z.number().int().positive().optional(),
  version: z.string().max(80).optional(),
});
const SpadeHealth = z.object({
  ok: z.literal(true),
  version: z.string().max(80),
  proof: z.string().max(128).optional(),
});
/** The token file's contents, which are both the bearer and the proof's key. */
const Token = z.string().min(16).max(512).regex(/^\S+$/);

export interface SpadeSwapIo {
  home: string;
  plan: SpadeServicePlan;
  /** The new release's `spade-server`. */
  source: string;
  version: string;
  run?: Runner;
  fetch?: typeof fetch;
  service?: SpadeServicePorts;
  nonce?: () => string;
  now?: () => number;
}

/** The real ports: Spade's local HTTP API, its SQLite file, the new binary and the service. */
export function localSpadeSwapPorts(io: SpadeSwapIo): SpadeSwapPorts {
  const { home, plan, source, version } = io;
  const run = io.run ?? runProcess;
  const send = io.fetch ?? fetch;
  const service = io.service ?? systemSpadePorts;
  const nonce = io.nonce ?? newSpadeNonce;
  const dataDir = join(home, "spade");
  const database = join(dataDir, "spade.sqlite");
  const snapshotDir = join(home, ".spade-update-snapshot");
  const checkDir = join(home, ".spade-migration-check");
  const endpoint = async () => {
    const server = SpadeServer.parse(
      JSON.parse(await readFile(join(dataDir, "server.json"), "utf8")),
    );
    return { ...server, token: Token.parse(await readFile(join(dataDir, "token"), "utf8")) };
  };
  /** Spade's health at `address`, believed only with the proof that it holds `token`. */
  const proven = async (address: string, token: string) => {
    const challenge = nonce();
    const response = await send(`http://${address}/health?nonce=${challenge}`, {
      signal: AbortSignal.timeout(2_000),
    });
    const health = SpadeHealth.parse(await response.json());
    return checkSpadeProof(token, challenge, health.proof) ? health : undefined;
  };
  const request = async (method: string, path: string, body?: unknown) => {
    const { address, token } = await endpoint();
    // The token goes only to the Spade that proves it already holds it.
    if (!(await proven(address, token)))
      throw new Error(`The process at ${address} isn't Spade: it didn't prove its token`);
    const response = await send(`http://${address}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Spade answered ${response.status} to ${method} ${path}`);
    return text;
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
          const { address, pid, token } = await endpoint();
          if (pid !== undefined && pid !== oldPid) {
            const health = await proven(address, token);
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
