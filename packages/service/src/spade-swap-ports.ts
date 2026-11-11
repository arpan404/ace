import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { DatabaseSync, backup } from "@ace/provider-kit/sqlite";
import { runProcess, type Runner } from "./process.ts";
import { spadeBinaryName, type SpadeServicePlan } from "./spade-plan.ts";
import { systemSpadePorts, type SpadeServicePorts } from "./spade-registration.ts";
import {
  flipSpadeCurrent,
  installedSpadeVersion,
  spadeReleases,
  stageSpadeBinary,
} from "./spade-release.ts";
import { restartSpadeService, spadeServiceState } from "./spade-service.ts";
import { SpadeMaintenance, type SpadeSwapPorts } from "./spade-swap.ts";

/** Spade's `server.json`: where it listens, written once it is ready (the contract). */
const SpadeServer = z.object({
  address: z.string().regex(/^127\.0\.0\.1:\d{1,5}$/),
  version: z.string().max(80).optional(),
});
const SpadeHealth = z.object({ ok: z.literal(true), version: z.string().max(80) });
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
  now?: () => number;
}

/** The real ports: Spade's local HTTP API, its SQLite file, the new binary and the service. */
export function localSpadeSwapPorts(io: SpadeSwapIo): SpadeSwapPorts {
  const { home, plan, source, version } = io;
  const run = io.run ?? runProcess;
  const send = io.fetch ?? fetch;
  const service = io.service ?? systemSpadePorts;
  const dataDir = join(home, "spade");
  const checkDir = join(home, ".spade-migration-check");
  const connection = async () => ({
    address: SpadeServer.parse(JSON.parse(await readFile(join(dataDir, "server.json"), "utf8")))
      .address,
    token: Token.parse((await readFile(join(dataDir, "token"), "utf8")).trim()),
  });
  const request = async (method: string, path: string, body?: unknown) => {
    const { address, token } = await connection();
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
      await request("POST", "/v1/maintenance", { mode, deadline_ms: deadlineMs });
      return status();
    },
    maintenance: status,
    async reopenAdmission() {
      await request("DELETE", "/v1/maintenance");
    },
    async stage() {
      await stageSpadeBinary(home, source, version);
    },
    async snapshot() {
      const database = join(dataDir, "spade.sqlite");
      if (!existsSync(database)) return undefined;
      await rm(checkDir, { recursive: true, force: true });
      await mkdir(checkDir, { mode: 0o700 });
      const copy = join(checkDir, "spade.sqlite");
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
      return copy;
    },
    async checkMigrations(snapshot) {
      const binary = join(spadeReleases(home), version, spadeBinaryName(process.platform));
      const result = await run(binary, ["--check-migrations", snapshot]);
      if (result.code !== 0)
        throw new Error(
          (result.stderr.trim() || `--check-migrations exited ${result.code}`).slice(0, 1000),
        );
    },
    async removeSnapshot() {
      await rm(checkDir, { recursive: true, force: true });
    },
    flip: (target) => flipSpadeCurrent(home, target),
    restart: () => restartSpadeService(plan, service),
    async health(target) {
      // A restart picks a new port, so server.json is read again on every try.
      for (let attempt = 0; attempt < 60; attempt++) {
        try {
          const { address } = await connection();
          const response = await send(`http://${address}/health`, {
            signal: AbortSignal.timeout(2_000),
          });
          if (SpadeHealth.parse(await response.json()).version === target) return true;
        } catch {}
        await service.wait(500);
      }
      return false;
    },
    wait: (ms) => service.wait(ms),
    now: io.now ?? Date.now,
  };
}
