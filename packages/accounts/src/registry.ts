import { DatabaseSync } from "node:sqlite";
import { mkdir, open, chmod, lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  AccountId,
  AccountEnvKey,
  ProviderInstance,
  AccountQuota,
  CursorSdkAuth,
} from "@ace/protocol/accounts";
import { object } from "./quota-decode.ts";
import { initialQuota, ingestQuota, availability, type QuotaFact } from "./quota.ts";
import { instanceEnv } from "./instances.ts";
import { pickInstance } from "./scheduler.ts";
import { canonicalHome } from "./paths.ts";
const row = z.object({ instance: z.string().max(32768), quota: z.string().max(16384) });

async function canonicalInstance(input: ProviderInstance): Promise<ProviderInstance> {
  const parsed = ProviderInstance.parse(input);
  instanceEnv(parsed, {});
  const homeDir = await canonicalHome(parsed.homeDir);
  const env: ProviderInstance["env"] = {};
  for (const key of Object.keys(parsed.env)) {
    const name = AccountEnvKey.parse(key);
    const value = parsed.env[name];
    if (value !== undefined) env[name] = await canonicalHome(value);
  }
  return ProviderInstance.parse({ ...parsed, homeDir, env });
}

function summarize(
  { instance, quota }: { instance: ProviderInstance; quota: AccountQuota },
  now: number,
) {
  return {
    id: instance.id,
    provider: instance.provider,
    label: instance.label,
    quota,
    availability: availability(quota, now),
  };
}

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
    const raw: unknown = JSON.parse(parsed.quota);
    const legacy = !Object.hasOwn(object(raw), "blockers");
    const quota = AccountQuota.parse(raw);
    // The previous format placed local blockers in the provider name namespace.
    if (legacy && quota.windows["quota_overflow"]?.usedPercent === 100) {
      quota.blockers.overflow = true;
      delete quota.windows["quota_overflow"];
    }
    if (legacy && quota.windows["limit_error"]) {
      quota.blockers.limitError = quota.windows["limit_error"];
      delete quota.windows["limit_error"];
    }
    return { instance: ProviderInstance.parse(JSON.parse(parsed.instance)), quota };
  }
  get(id: string) {
    const value = this.select.get(AccountId.parse(id));
    return value === undefined ? undefined : this.decode(value);
  }
  setCursorSdkAuth(id: string, input: unknown): void {
    const status = CursorSdkAuth.parse(input);
    const account = this.get(id);
    if (!account || account.instance.provider !== "cursor")
      throw new Error("Unknown Cursor instance");
    this.updateQuota.run(JSON.stringify({ ...account.quota, cursorSdkAuth: status }), id);
  }
  list() {
    const rows = this.all.all();
    if (rows.length > 256) throw new Error("Instance limit exceeded");
    return rows.map((value) => this.decode(value));
  }
  async register(input: ProviderInstance) {
    const instance = await canonicalInstance(input);
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
            AccountEnvKey.options.some((key) => other.instance.env[key] !== instance.env[key]) ||
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
  /** Upgrade old lexical identities before accepting assignments or writes. */
  async canonicalizeHomes() {
    const accounts = this.list();
    const normalized = [];
    for (const account of accounts)
      normalized.push({ ...account, instance: await canonicalInstance(account.instance) });
    const roots = new Map<string, Set<string>>();
    for (const { instance } of normalized) {
      const used = roots.get(instance.provider) ?? new Set<string>();
      const selectors = new Set([instance.homeDir, ...Object.values(instance.env)]);
      for (const path of selectors)
        if (used.has(path)) throw new Error("Instance homes must be distinct");
      for (const path of selectors) used.add(path);
      roots.set(instance.provider, used);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const { instance } of normalized) {
        const current = this.get(instance.id);
        if (!current) throw new Error("Instance changed during canonicalization");
        this.upsert.run(
          instance.id,
          JSON.stringify({ ...instance, label: current.instance.label }),
          JSON.stringify(current.quota),
        );
      }
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
  summary(id: string, now: number) {
    const account = this.get(id);
    return account ? summarize(account, now) : undefined;
  }
  summaries(now: number) {
    return this.list().map((account) => summarize(account, now));
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
  const registry = new AccountRegistry(new DatabaseSync(path));
  try {
    await registry.canonicalizeHomes();
    return registry;
  } catch (error) {
    registry.close();
    throw error;
  }
}
