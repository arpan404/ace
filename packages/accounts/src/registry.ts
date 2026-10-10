import { accountShortLabel } from "./labels.ts";
import { cursorInstanceId, cursorDefaultInstanceId } from "@ace/provider-kit/cursor-selection";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { assertTestHomeIsolation } from "@ace/provider-kit/test-isolation";
import { mkdir, open, chmod, lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  AccountId,
  AccountBadgeInput,
  AccountInstanceId,
  AccountEnvKey,
  ProviderInstance,
  AccountQuota,
  CursorSdkAuth,
} from "@ace/protocol/accounts";
import { object } from "./quota-decode.ts";
import { availability, blockedUntil } from "./availability.ts";
import { initialQuota, ingestQuota, type QuotaFact } from "./quota.ts";
import { instanceEnv } from "./instances.ts";
import { pickInstance } from "./scheduler.ts";
import { assertManagedHome } from "./managed-home.ts";
import { canonicalHome } from "./paths.ts";
import { migrateInstanceHome, type HomeMigrationNotice } from "./instance-home-migration.ts";
const selectionRow = z.object({ backend: z.string(), instance_id: AccountInstanceId });
const row = z.object({ instance: z.string().max(32768), quota: z.string().max(16384) });

async function canonicalInstance(input: ProviderInstance): Promise<ProviderInstance> {
  const parsed = ProviderInstance.parse({ ...input, shortLabel: accountShortLabel(input) });
  instanceEnv(parsed, {});
  if (parsed.implicit) return parsed;
  // Managed identities are immutable. validateHome refuses aliases instead of rewriting them.
  if (parsed.managed) return parsed;
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
    implicit: instance.implicit ?? false,
    ...(instance.implicit ? { cliHome: instance.homeDir } : {}),
    provider: instance.provider,
    label: instance.label,
    shortLabel: accountShortLabel(instance),
    badgeColor: instance.badgeColor,
    authMethod: instance.authMethod ?? "unknown",
    ...(instance.signedInAs ? { signedInAs: instance.signedInAs } : {}),
    ...(instance.provider === "acp"
      ? {
          acpAgentId: instance.acpAgentId,
          installationId: instance.installationId,
          instanceId: instance.id,
          homeStrategy: instance.homeStrategy,
          isolation: "unsupported" as const,
          profileRevision: instance.profileRevision,
          installationVersion: instance.installationVersion,
        }
      : {}),
    loginRevision: instance.loginRevision ?? "0",
    quota,
    availability: availability(quota, now),
    blockedUntil: blockedUntil(quota, now),
  };
}

export class AccountRegistry {
  private readonly quotaListeners = new Set<(id: string) => void>();
  subscribeQuota(listener: (id: string) => void): () => void {
    this.quotaListeners.add(listener);
    return () => this.quotaListeners.delete(listener);
  }
  private db: DatabaseSync;
  private pending = new Set<string>();
  private homeMigration: { notice?: (event: HomeMigrationNotice) => void } | undefined;
  private validating = false;
  private managedDataDir: string | undefined;
  ready: Promise<void> = Promise.resolve();
  private select;
  private all;
  private upsert;
  private updateQuota;
  private selection;
  private selections;
  private setSelection;
  private clearSelection;
  private deleteSelections;
  private deleteAccount;
  constructor(
    db: DatabaseSync,
    managedDataDir?: string,
    homeMigration?: { notice?: (event: HomeMigrationNotice) => void },
  ) {
    this.db = db;
    this.homeMigration = homeMigration;
    this.managedDataDir = managedDataDir;
    db.exec("PRAGMA busy_timeout = 3000");
    db.exec(
      "CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, instance TEXT NOT NULL, quota TEXT NOT NULL)",
    );
    db.exec(
      "CREATE TABLE IF NOT EXISTS account_selection (backend TEXT PRIMARY KEY, instance_id TEXT NOT NULL REFERENCES accounts(id))",
    );
    db.exec("CREATE TABLE IF NOT EXISTS pending_accounts (id TEXT PRIMARY KEY)");
    for (const value of db.prepare("SELECT id FROM pending_accounts LIMIT 257").all())
      this.pending.add(AccountId.parse(value.id));
    this.selection = db.prepare("SELECT instance_id FROM account_selection WHERE backend=?");
    this.selections = db.prepare("SELECT backend, instance_id FROM account_selection LIMIT 257");
    this.setSelection = db.prepare(
      "INSERT INTO account_selection VALUES (?,?) ON CONFLICT(backend) DO UPDATE SET instance_id=excluded.instance_id",
    );
    this.clearSelection = db.prepare("DELETE FROM account_selection WHERE backend=?");
    this.deleteSelections = db.prepare("DELETE FROM account_selection WHERE instance_id=?");
    this.deleteAccount = db.prepare("DELETE FROM accounts WHERE id=?");
    // Retire metadata before home canonicalization. Never inspect the old CLI home.
    db.exec(`DELETE FROM account_selection WHERE instance_id='cursor-cli-default';
      DELETE FROM accounts WHERE id='cursor-cli-default' AND json_extract(instance,'$.implicit')=1;`);
    this.updateQuota = db.prepare("UPDATE accounts SET quota=? WHERE id=?");
    this.select = db.prepare("SELECT instance, quota FROM accounts WHERE id = ?");
    this.all = db.prepare("SELECT instance, quota FROM accounts ORDER BY id LIMIT 257");
    this.upsert = db.prepare(
      "INSERT INTO accounts VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET instance=excluded.instance, quota=excluded.quota",
    );
  }
  async validateHome(instance: ProviderInstance): Promise<void> {
    const problem = this.readAccount(instance.id)?.quota.blockers.homeUnavailable;
    if (problem) throw new Error(problem);
    if (!instance.managed) return;
    if (!this.managedDataDir) throw new Error("Managed account needs its daemon data root");
    await assertManagedHome(this.managedDataDir, instance);
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
    if (this.validating) throw new Error("Account homes are still being validated");
    return this.readAccount(id);
  }
  private readAccount(id: string) {
    const value = this.select.get(AccountInstanceId.parse(id));
    return value === undefined ? undefined : this.decode(value);
  }
  setCursorSdkAuth(id: string, input: unknown): void {
    const status = CursorSdkAuth.parse(input);
    const account = this.get(id);
    if (!account || account.instance.provider !== "cursor")
      throw new Error("Unknown Cursor instance");
    this.updateQuota.run(JSON.stringify({ ...account.quota, cursorSdkAuth: status }), id);
  }
  selectedCursorSdk(): string | undefined {
    return this.selectedProvider("cursor");
  }
  selectCursorSdk(id: string | undefined): void {
    if (id === undefined) {
      this.clearSelection.run("cursor-sdk");
      this.clearSelection.run("provider:cursor");
      return;
    }
    if (this.get(id)?.instance.provider !== "cursor") throw new Error("Unknown Cursor instance");
    this.selectProvider("cursor", AccountId.parse(id));
  }
  list() {
    if (this.validating) throw new Error("Account homes are still being validated");
    return this.readAccounts().filter(({ instance }) => !this.pending.has(instance.id));
  }
  private readAccounts() {
    const rows = this.all.all();
    if (rows.length > 256) throw new Error("Instance limit exceeded");
    return rows.map((value) => this.decode(value));
  }
  register(input: ProviderInstance) {
    return this.registerWith(input, () => {});
  }
  /** A login owns this home until it succeeds; public lists and scheduling never see it. */
  registerPending(input: ProviderInstance) {
    return this.registerWith(
      input,
      () => {
        this.db.prepare("INSERT INTO pending_accounts VALUES (?)").run(input.id);
      },
      () => this.pending.add(input.id),
    );
  }
  isPending(id: string): boolean {
    return this.pending.has(id);
  }
  pendingInstances() {
    return this.readAccounts().filter(({ instance }) => this.pending.has(instance.id));
  }
  publishAccount(id: string): void {
    this.db.prepare("DELETE FROM pending_accounts WHERE id=?").run(id);
    this.pending.delete(id);
    for (const listener of this.quotaListeners) listener(id);
  }
  private async registerWith(
    input: ProviderInstance,
    beforeCommit: () => void,
    afterCommit: () => void = () => {},
  ) {
    const instance = await canonicalInstance(input);
    await this.validateHome(instance);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const accounts = this.readAccounts();
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
            other.instance.managed !== instance.managed ||
            other.instance.implicit !== instance.implicit ||
            other.instance.homeDir !== instance.homeDir ||
            other.instance.acpAgentId !== instance.acpAgentId ||
            other.instance.installationId !== instance.installationId ||
            other.instance.instanceId !== instance.instanceId ||
            other.instance.homeStrategy !== instance.homeStrategy
          )
            throw new Error("An instance identity cannot change homes or agents");
          continue;
        }
        if (
          other.instance.implicit ||
          instance.implicit ||
          other.instance.provider !== instance.provider ||
          instance.provider === "acp"
        )
          continue;
        if (
          [other.instance.homeDir, ...Object.values(other.instance.env)].some((p) =>
            roots.has(resolve(p)),
          )
        )
          throw new Error("Instance homes must be distinct");
      }
      const current = this.get(instance.id);
      this.upsert.run(
        instance.id,
        JSON.stringify({
          ...instance,
          loginRevision: current?.instance.loginRevision ?? instance.loginRevision ?? "0",
        }),
        JSON.stringify(current?.quota ?? initialQuota()),
      );
      beforeCommit();
      this.db.exec("COMMIT");
      afterCommit();
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  /** Upgrade old lexical identities before accepting assignments or writes. */
  canonicalizeHomes(signal?: AbortSignal): Promise<void> {
    this.validating = true;
    this.ready = this.normalizeHomes(signal);
    // Consumers can use readiness later; prevent an unhandled failure meanwhile.
    void this.ready.catch(() => undefined);
    return this.ready;
  }
  private async normalizeHomes(signal?: AbortSignal): Promise<void> {
    const accounts = this.readAccounts().filter(({ instance }) => !this.pending.has(instance.id));
    const normalized = [];
    const roots = new Map<string, Set<string>>();
    for (const account of accounts) {
      signal?.throwIfAborted();
      const quota = { ...account.quota, blockers: { ...account.quota.blockers } };
      delete quota.blockers.homeUnavailable;
      try {
        const migrated = this.managedDataDir
          ? await migrateInstanceHome(
              account.instance,
              this.managedDataDir,
              this.homeMigration?.notice,
            )
          : account.instance;
        const instance = await canonicalInstance(migrated);
        // Startup revalidates repaired homes rather than trusting last startup's blocker.
        if (instance.managed) {
          if (!this.managedDataDir) throw new Error("Managed account needs its data root");
          await assertManagedHome(this.managedDataDir, instance);
        } else if (!instance.implicit && instance.provider !== "acp") {
          const stat = await lstat(instance.homeDir);
          if (!stat.isDirectory()) throw new Error("home_missing");
        }
        if (instance.provider !== "acp" && !instance.implicit) {
          const used = roots.get(instance.provider) ?? new Set<string>();
          const selectors = new Set([instance.homeDir, ...Object.values(instance.env)]);
          for (const path of selectors) if (used.has(path)) throw new Error("home_conflict");
          for (const path of selectors) used.add(path);
          roots.set(instance.provider, used);
        }
        normalized.push({ instance, quota });
      } catch (error) {
        signal?.throwIfAborted();
        const code = error instanceof Error && "code" in error ? error.code : undefined;
        quota.blockers.homeUnavailable =
          error instanceof Error && error.message === "foreign_home"
            ? "foreign_home"
            : error instanceof Error && error.message === "home_conflict"
              ? "home_conflict"
              : code === "ENOENT" || code === "ENOTDIR"
                ? "home_missing"
                : "home_unreadable";
        normalized.push({ instance: account.instance, quota });
      }
    }
    signal?.throwIfAborted();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const { instance, quota } of normalized) {
        const current = this.readAccount(instance.id);
        if (!current) throw new Error("Instance changed during canonicalization");
        this.upsert.run(
          instance.id,
          JSON.stringify({
            ...instance,
            label: current.instance.label,
            shortLabel: current.instance.shortLabel,
            badgeColor: current.instance.badgeColor,
          }),
          JSON.stringify({ ...current.quota, blockers: quota.blockers }),
        );
      }
      this.db.exec("COMMIT");
      this.validating = false;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  /** CLI-owned login completed; invalidate only this immutable account generation. */
  loginChanged(id: string): void {
    const account = this.get(id);
    if (!account) throw new Error("Unknown instance");
    const previous = account.instance.loginRevision ?? "0";
    if (!/^\d{1,15}$/.test(previous)) throw new Error("Invalid login revision");
    const revision = Number(previous) + 1;
    if (revision > 999999999999999) throw new Error("Login revision capacity reached");
    this.upsert.run(
      id,
      JSON.stringify({ ...account.instance, loginRevision: String(revision) }),
      JSON.stringify(account.quota),
    );
  }
  /** An installed ACP agent confirmed authentication; arbitrary ACP frames stay opaque. */
  recordAcpAuth(id: string, auth: "logged_in" | "logged_out", observedAt: number): void {
    const account = this.get(id);
    if (!account || account.instance.provider !== "acp") throw new Error("ACP account required");
    const quota = AccountQuota.parse({ ...account.quota, auth, observedAt });
    this.loginChanged(id);
    this.updateQuota.run(JSON.stringify(quota), id);
    for (const listener of this.quotaListeners) {
      try {
        listener(id);
      } catch {
        /* Reader owns delivery. */
      }
    }
  }
  recordAuth(id: string, method: "browser" | "api_key" | "unknown", signedInAs?: string): void {
    const account = this.get(id);
    if (!account) throw new Error("Unknown instance");
    const instance = { ...account.instance };
    delete instance.signedInAs;
    this.upsert.run(
      id,
      JSON.stringify(
        ProviderInstance.parse({
          ...instance,
          authMethod: method,
          ...(signedInAs ? { signedInAs } : {}),
        }),
      ),
      JSON.stringify(account.quota),
    );
  }
  ingest(id: string, fact: QuotaFact) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const account = this.get(id);
      if (!account) throw new Error("Unknown instance");
      if (fact.provider !== account.instance.provider) throw new Error("Provider mismatch");
      const result = ingestQuota(account.quota, fact);
      // An unreadable status is not evidence that the signed-in identity changed.
      if (result.state.auth !== account.quota.auth && result.state.auth !== "unknown")
        this.loginChanged(id);
      if (result.state !== account.quota)
        this.updateQuota.run(JSON.stringify(AccountQuota.parse(result.state)), id);
      this.db.exec("COMMIT");
      const before = {
        windows: account.quota.windows,
        blockers: account.quota.blockers,
        auth: account.quota.auth,
        billingMode: account.quota.billingMode,
        plan: account.quota.plan,
      };
      const after = {
        windows: result.state.windows,
        blockers: result.state.blockers,
        auth: result.state.auth,
        billingMode: result.state.billingMode,
        plan: result.state.plan,
      };
      if (JSON.stringify(before) !== JSON.stringify(after))
        for (const listener of this.quotaListeners) {
          // A disconnected reader must not invalidate a committed quota observation.
          try {
            listener(id);
          } catch {
            /* Reader owns its delivery failure. */
          }
        }
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  selectedProvider(provider: string): string | undefined {
    const value =
      this.selection.get(`provider:${provider}`) ??
      (provider === "cursor" ? this.selection.get("cursor-sdk") : undefined);
    const id = value ? AccountInstanceId.parse(value.instance_id) : undefined;
    return provider === "cursor" ? cursorInstanceId(id) : id;
  }
  selectProvider(provider: string, id: string): void {
    id = provider === "cursor" ? (cursorInstanceId(id) ?? id) : id;
    if (this.pending.has(id) || this.get(id)?.instance.provider !== provider)
      throw new Error("Provider mismatch");
    this.setSelection.run(`provider:${provider}`, id);
    if (provider === "cursor") this.clearSelection.run("cursor-sdk");
  }
  rename(
    id: string,
    label: string,
    badge: {
      shortLabel?: string | undefined;
      badgeColor?: ProviderInstance["badgeColor"] | null | undefined;
    } = {},
  ): void {
    const account = this.get(id);
    if (!account || account.instance.implicit) throw new Error("Account is immutable");
    if (badge.shortLabel !== undefined) AccountBadgeInput.parse(badge.shortLabel);
    this.upsert.run(
      id,
      JSON.stringify(
        ProviderInstance.parse({
          ...account.instance,
          label,
          shortLabel:
            badge.shortLabel ?? account.instance.shortLabel ?? accountShortLabel({ label }),
          badgeColor:
            badge.badgeColor === null
              ? undefined
              : (badge.badgeColor ?? account.instance.badgeColor),
        }),
      ),
      JSON.stringify(account.quota),
    );
    for (const listener of this.quotaListeners) listener(id);
  }
  unregister(id: string): void {
    const account = this.get(id);
    if (!account || account.instance.implicit) throw new Error("Account is immutable");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.deleteSelections.run(id);
      this.deleteAccount.run(id);
      this.publishAccount(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  summary(id: string, now: number) {
    const account = this.get(id);
    return account && !this.pending.has(id)
      ? {
          ...summarize(account, now),
          isDefault:
            (this.selectedProvider(account.instance.provider) ??
              (account.instance.provider === "cursor"
                ? (this.selectedCursorSdk() ?? cursorDefaultInstanceId)
                : `${account.instance.provider}-cli-default`)) === id,
        }
      : undefined;
  }
  summaries(now: number) {
    const selected = new Map(
      this.selections.all().map((value) => {
        const selectedRow = selectionRow.parse(value);
        return [selectedRow.backend, selectedRow.instance_id];
      }),
    );
    return this.list()
      .filter(({ instance }) => !this.pending.has(instance.id))
      .map((account) =>
        Object.assign(summarize(account, now), {
          isDefault:
            (selected.get(`provider:${account.instance.provider}`) ??
              (account.instance.provider === "cursor"
                ? (this.selectedCursorSdk() ?? cursorDefaultInstanceId)
                : `${account.instance.provider}-cli-default`)) === account.instance.id,
        }),
      );
  }
  pickInstance(input: Parameters<typeof pickInstance>[0], now: number) {
    return pickInstance(
      input,
      this.list().filter(({ instance }) => !this.pending.has(instance.id)),
      now,
    );
  }
  close() {
    this.quotaListeners.clear();
    this.db.close();
  }
}

export async function openRegistryIndex(
  path: string,
  signal?: AbortSignal,
  managedDataDir: string = dirname(path),
  homeMigration?: { notice?: (event: HomeMigrationNotice) => void },
): Promise<AccountRegistry> {
  assertTestHomeIsolation(path);
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
  const registry = new AccountRegistry(new DatabaseSync(path), managedDataDir, homeMigration);
  registry.canonicalizeHomes(signal);
  return registry;
}

export async function openRegistry(
  path: string,
  managedDataDir: string = dirname(path),
): Promise<AccountRegistry> {
  const registry = await openRegistryIndex(path, undefined, managedDataDir);
  try {
    await registry.ready;
    return registry;
  } catch (error) {
    registry.close();
    throw error;
  }
}
