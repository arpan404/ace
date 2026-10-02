import { DatabaseSync } from "node:sqlite";
import { mkdir, open, chmod, lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { AccountId, ProviderInstance, AccountQuota } from "@ace/protocol/accounts";
import { initialQuota, ingestQuota, availability, type QuotaFact } from "./quota.ts";
import { instanceEnv } from "./instances.ts";
import { pickInstance } from "./scheduler.ts";
const row = z.object({ instance: z.string().max(32768), quota: z.string().max(16384) });

export class AccountRegistry {
  private db: DatabaseSync;
  private select;
  private all;
  private upsert;
  private updateQuota;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec("PRAGMA busy_timeout = 3000");
    db.exec(
      "CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, instance TEXT NOT NULL, quota TEXT NOT NULL)",
    );
    this.updateQuota = db.prepare("UPDATE accounts SET quota=? WHERE id=?");
    this.select = db.prepare("SELECT instance, quota FROM accounts WHERE id = ?");
    this.all = db.prepare("SELECT instance, quota FROM accounts ORDER BY id LIMIT 257");
    this.upsert = db.prepare(
      "INSERT INTO accounts VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET instance=excluded.instance, quota=excluded.quota",
    );
  }
  private decode(value: unknown) {
    const parsed = row.parse(value);
    return {
      instance: ProviderInstance.parse(JSON.parse(parsed.instance)),
      quota: AccountQuota.parse(JSON.parse(parsed.quota)),
    };
  }
  get(id: string) {
    const value = this.select.get(AccountId.parse(id));
    return value === undefined ? undefined : this.decode(value);
  }
  list() {
    const rows = this.all.all();
    if (rows.length > 256) throw new Error("Instance limit exceeded");
    return rows.map((value) => this.decode(value));
  }
  register(input: ProviderInstance) {
    const instance = ProviderInstance.parse(input);
    instanceEnv(instance, {});
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const accounts = this.list();
      if (accounts.length >= 256 && !accounts.some((a) => a.instance.id === instance.id))
        throw new Error("Instance limit exceeded");
      const roots = new Set(
        [instance.homeDir, ...Object.values(instance.env)].map((p) => resolve(p)),
      );
      for (const other of accounts) {
        if (other.instance.id === instance.id) {
          if (
            JSON.stringify(other.instance.env) !== JSON.stringify(instance.env) ||
            other.instance.provider !== instance.provider ||
            other.instance.homeDir !== instance.homeDir
          )
            throw new Error("An instance ID cannot change homes");
          continue;
        }
        if (other.instance.provider !== instance.provider) continue;
        if (
          [other.instance.homeDir, ...Object.values(other.instance.env)].some((p) =>
            roots.has(resolve(p)),
          )
        )
          throw new Error("Instance homes must be distinct");
      }
      const current = this.get(instance.id)?.quota ?? initialQuota();
      this.upsert.run(instance.id, JSON.stringify(instance), JSON.stringify(current));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  ingest(id: string, fact: QuotaFact) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const account = this.get(id);
      if (!account) throw new Error("Unknown instance");
      if (fact.provider !== account.instance.provider) throw new Error("Provider mismatch");
      const result = ingestQuota(account.quota, fact);
      if (result.state !== account.quota)
        this.updateQuota.run(JSON.stringify(AccountQuota.parse(result.state)), id);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  summaries(now: number) {
    return this.list().map(({ instance, quota }) => ({
      id: instance.id,
      provider: instance.provider,
      label: instance.label,
      quota,
      availability: availability(quota, now),
    }));
  }
  pickInstance(input: Parameters<typeof pickInstance>[0], now: number) {
    return pickInstance(input, this.list(), now);
  }
  close() {
    this.db.close();
  }
}

export async function openRegistry(path: string): Promise<AccountRegistry> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const file = await open(path, "wx", 0o600);
    await file.close();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Registry must be a regular file");
  await chmod(path, 0o600);
  return new AccountRegistry(new DatabaseSync(path));
}
