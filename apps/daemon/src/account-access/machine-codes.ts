import { scrypt, timingSafeEqual } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { z } from "zod";
import type { CodeLock } from "./machine-code-policy.ts";

const Row = z.object({
  hash: z.string().nullable(),
  version: z.number().int(),
  failures: z.number().int(),
  locked_until: z.number().int().nullable(),
});
// scrypt's defaults (N=2^14, r=8, p=1) stay inside Node's default memory cap.
const cost = { N: 16384, r: 8, p: 1 } as const;

function derive(code: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(code.normalize("NFKC"), salt, 32, cost, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
}

/** `scrypt$N$r$p$salt$key`, base64url parts. */
export async function hashMachineCode(code: string, salt: Buffer): Promise<string> {
  const key = await derive(code, salt);
  return `scrypt$${cost.N}$${cost.r}$${cost.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function machineCodeMatches(code: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, key] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !key) return false;
  if (Number(n) !== cost.N || Number(r) !== cost.r || Number(p) !== cost.p) return false;
  const expected = Buffer.from(key, "base64url");
  const actual = await derive(code, Buffer.from(salt, "base64url"));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** The machine code row and remembered passes, on the daemon store's SQLite connection. */
export class MachineCodes {
  private readonly read: StatementSync;
  private readonly write: StatementSync;
  private readonly writeLock: StatementSync;
  private readonly pass: StatementSync;
  private readonly remember: StatementSync;
  private readonly forgetOld: StatementSync;
  constructor(db: DatabaseSync) {
    this.read = db.prepare(
      "SELECT hash, version, failures, locked_until FROM machine_code WHERE id = 1",
    );
    this.write = db.prepare(
      `INSERT INTO machine_code (id, hash, version, failures, locked_until) VALUES (1, ?, 1, 0, NULL)
       ON CONFLICT(id) DO UPDATE SET hash = excluded.hash, version = machine_code.version + 1,
         failures = 0, locked_until = NULL`,
    );
    this.writeLock = db.prepare(
      "UPDATE machine_code SET failures = ?, locked_until = ? WHERE id = 1",
    );
    this.pass = db.prepare(
      "SELECT 1 AS passed FROM machine_code_passes WHERE device_id = ? AND account = ? AND version = ?",
    );
    this.remember = db.prepare(
      `INSERT INTO machine_code_passes (device_id, account, version, passed_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(device_id, account) DO UPDATE SET version = excluded.version, passed_at = excluded.passed_at`,
    );
    this.forgetOld = db.prepare("DELETE FROM machine_code_passes WHERE version <> ?");
  }
  private row() {
    const row = this.read.get();
    return row ? Row.parse(row) : undefined;
  }
  /** The current code's hash and version; undefined while no code is set. */
  current(): { hash: string; version: number } | undefined {
    const row = this.row();
    return row?.hash ? { hash: row.hash, version: row.version } : undefined;
  }
  lock(): CodeLock {
    const row = this.row();
    return { failures: row?.failures ?? 0, lockedUntil: row?.locked_until ?? null };
  }
  saveLock(lock: CodeLock): void {
    this.writeLock.run(lock.failures, lock.lockedUntil);
  }
  /** Set (a hash) or clear (null) the code. Either way the version moves on, so every device enters it anew. */
  replace(hash: string | null): void {
    this.write.run(hash);
    const row = this.row();
    if (row) this.forgetOld.run(row.version);
  }
  passed(deviceId: string, account: string, version: number): boolean {
    return this.pass.get(deviceId, account, version) !== undefined;
  }
  rememberPass(deviceId: string, account: string, version: number, at: number): void {
    this.remember.run(deviceId, account, version, at);
  }
}
