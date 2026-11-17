import { accountShortLabel, defaultAccountBadgeColor } from "./labels.ts";
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
import { availability, blockedUntil } from "./availability.ts";
import { initialQuota, ingestQuota, type QuotaFact } from "./quota.ts";
import { pickInstance } from "./scheduler.ts";
import { assertManagedHome, restoreCursorHome } from "./managed-home.ts";
import {
  canonicalInstance,
  homeCheckPatienceMs,
  homeProblem,
  readHome,
  realAfter,
  withinPatience,
  type HomeCheckOptions,
} from "./home-checks.ts";
import { antigravitySignInOf } from "./antigravity-sign-in.ts";
import { accountProvider } from "./acp-instances.ts";
const selectionRow = z.object({ backend: z.string(), instance_id: AccountInstanceId });
const row = z.object({ instance: z.string().max(32768), quota: z.string().max(16384) });

/**
 * ACP accounts on the agent's default home all share the person's own; managed ones, like native
 * accounts, each need a home of their own.
 */
const sharedDefault = (account: ProviderInstance) =>
  account.provider === "acp" && account.homeStrategy !== "managed";

/** ACP agents each keep their own default account. */
const acpSelectionKey = (acpAgentId: string) => `provider:acp:${acpAgentId}`;

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
    badgeUsesInitial: instance.shortLabel === undefined,
    badgeColor: instance.badgeColor ?? defaultAccountBadgeColor(instance.id),
    ...(instance.badgeIcon ? { badgeIcon: instance.badgeIcon } : {}),
    authMethod: instance.authMethod ?? "unknown",
    ...(instance.signedInAs ? { signedInAs: instance.signedInAs } : {}),
    ...(instance.provider === "acp"
      ? {
          acpAgentId: instance.acpAgentId,
          installationId: instance.installationId,
          instanceId: instance.id,
          homeStrategy: instance.homeStrategy,
          ...(instance.homeStrategy === "managed" ? {} : { isolation: "unsupported" as const }),
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
  /** Accounts whose home hasn't answered this run's check yet; settles when it does. */
  private checks = new Map<string, Promise<void>>();
  private managedDataDir: string | undefined;
  /** Every saved home has answered. While one hangs, this waits with it. */
  ready: Promise<void> = Promise.resolve();
  /** Every saved home has answered, or the ones that haven't were left checking. */
  firstPass: Promise<void> = Promise.resolve();
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
  private signInMethod;
  private setSignInMethod;
  private clearSignInMethod;
  constructor(db: DatabaseSync, managedDataDir?: string) {
    this.db = db;
    this.managedDataDir = managedDataDir;
    db.exec("PRAGMA busy_timeout = 3000");
    db.exec(
      "CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, instance TEXT NOT NULL, quota TEXT NOT NULL)",
    );
    db.exec(
      "CREATE TABLE IF NOT EXISTS account_selection (backend TEXT PRIMARY KEY, instance_id TEXT NOT NULL REFERENCES accounts(id))",
    );
    db.exec("CREATE TABLE IF NOT EXISTS pending_accounts (id TEXT PRIMARY KEY)");
    // Which of an ACP agent's own methods the person signed in with: an id, never a credential.
    db.exec("CREATE TABLE IF NOT EXISTS acp_sign_in (id TEXT PRIMARY KEY, method TEXT NOT NULL)");
    this.signInMethod = db.prepare("SELECT method FROM acp_sign_in WHERE id=?");
    this.setSignInMethod = db.prepare(
      "INSERT INTO acp_sign_in VALUES (?,?) ON CONFLICT(id) DO UPDATE SET method=excluded.method",
    );
    this.clearSignInMethod = db.prepare("DELETE FROM acp_sign_in WHERE id=?");
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
    // Earlier builds assigned neutral to every CLI login. Retire that automatic metadata once;
    // later explicit choices, including neutral, survive reopening and rediscovery.
    db.exec("CREATE TABLE IF NOT EXISTS account_metadata_migrations (name TEXT PRIMARY KEY)");
    db.exec("BEGIN IMMEDIATE");
    try {
      if (
        !db.prepare("SELECT name FROM account_metadata_migrations WHERE name='badge-palette'").get()
      ) {
        const update = db.prepare("UPDATE accounts SET instance=? WHERE id=?");
        for (const value of db.prepare("SELECT instance, quota FROM accounts LIMIT 257").all()) {
          const instance = ProviderInstance.parse(JSON.parse(row.parse(value).instance));
          if (instance.implicit && instance.badgeColor === "neutral")
            update.run(
              JSON.stringify({ ...instance, badgeColor: defaultAccountBadgeColor(instance.id) }),
              instance.id,
            );
        }
        db.exec("INSERT INTO account_metadata_migrations VALUES ('badge-palette')");
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    this.updateQuota = db.prepare("UPDATE accounts SET quota=? WHERE id=?");
    this.select = db.prepare("SELECT instance, quota FROM accounts WHERE id = ?");
    this.all = db.prepare("SELECT instance, quota FROM accounts ORDER BY id LIMIT 257");
    this.upsert = db.prepare(
      "INSERT INTO accounts VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET instance=excluded.instance, quota=excluded.quota",
    );
  }
  /** Whether this account's home hasn't answered its startup check yet. */
  isChecking(id: string): boolean {
    return this.checks.has(id);
  }
  /** Settles once this account's home has answered (at once if it already has). */
  checked(id: string): Promise<void> {
    return this.checks.get(id) ?? Promise.resolve();
  }
  /** Accounts of one provider (or ACP agent's) whose homes are still being checked. */
  checkingIds(provider: string): string[] {
    return this.readAccounts()
      .filter(
        ({ instance }) => this.checks.has(instance.id) && accountProvider(instance) === provider,
      )
      .map(({ instance }) => instance.id);
  }
  async validateHome(instance: ProviderInstance): Promise<void> {
    // Work never runs in a home that hasn't answered; callers that can wait use `checked`.
    if (this.checks.has(instance.id)) throw new Error("Account folder hasn't answered yet");
    const problem = this.readAccount(instance.id)?.quota.blockers.homeUnavailable;
    if (problem) throw new Error(problem);
    if (!instance.managed) return;
    if (!this.managedDataDir) throw new Error("Managed account needs its daemon data root");
    await assertManagedHome(this.managedDataDir, instance);
  }
  /** A user-requested Cursor sign-in can repair a missing private folder without a restart. */
  async restoreCursorHome(id: string): Promise<void> {
    const account = this.get(id);
    if (!account || !this.managedDataDir) throw new Error("Account unavailable");
    const problem = account.quota.blockers.homeUnavailable;
    if (problem === "foreign_home" || problem === "home_conflict" || problem === "home_checking")
      throw new Error(problem);
    const created = await restoreCursorHome(this.managedDataDir, account.instance);
    const current = this.get(id);
    if (!current || current.instance.homeDir !== account.instance.homeDir)
      throw new Error("Account changed during home recovery");
    const quota = { ...current.quota, blockers: { ...current.quota.blockers } };
    delete quota.blockers.homeUnavailable;
    if (created) {
      quota.auth = "unknown";
      delete quota.cursorSdkAuth;
    }
    this.updateQuota.run(JSON.stringify(quota), id);
    for (const listener of this.quotaListeners) listener(id);
  }
  private decode(value: unknown) {
    const parsed = row.parse(value);
    const quota = AccountQuota.parse(JSON.parse(parsed.quota));
    // "Checking" is this run's fact, never a stored one.
    if (quota.blockers.homeUnavailable === "home_checking") {
      quota.blockers = { ...quota.blockers };
      delete quota.blockers.homeUnavailable;
    }
    return { instance: ProviderInstance.parse(JSON.parse(parsed.instance)), quota };
  }
  /**
   * An account whose home hasn't answered reads as `home_checking`: listed and named, never
   * missing, and never available, so nothing picks it or another account in its place unseen.
   */
  private reported<T extends { instance: ProviderInstance; quota: AccountQuota }>(account: T): T {
    if (!this.checks.has(account.instance.id)) return account;
    return {
      ...account,
      quota: {
        ...account.quota,
        blockers: { ...account.quota.blockers, homeUnavailable: "home_checking" },
      },
    };
  }
  get(id: string) {
    const account = this.readAccount(id);
    return account && this.reported(account);
  }
  private readAccount(id: string) {
    const value = this.select.get(AccountInstanceId.parse(id));
    return value === undefined ? undefined : this.decode(value);
  }
  setCursorSdkAuth(id: string, input: unknown): void {
    const status = CursorSdkAuth.parse(input);
    const account = this.readAccount(id);
    if (!account || account.instance.provider !== "cursor")
      throw new Error("Unknown Cursor instance");
    this.updateQuota.run(JSON.stringify({ ...account.quota, cursorSdkAuth: status }), id);
    // The SDK login's own record of who signed in reads as the account's "signed in as".
    if (status.email && account.instance.signedInAs !== status.email)
      this.recordAuth(id, account.instance.authMethod ?? "browser", status.email);
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
    return this.readAccounts()
      .filter(({ instance }) => !this.pending.has(instance.id))
      .map((account) => this.reported(account));
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
          sharedDefault(instance) ||
          sharedDefault(other.instance)
        )
          continue;
        if (
          [other.instance.homeDir, ...Object.values(other.instance.env)].some((p) =>
            roots.has(resolve(p)),
          )
        )
          throw new Error("Instance homes must be distinct");
      }
      const current = this.readAccount(instance.id);
      this.upsert.run(
        instance.id,
        JSON.stringify({
          ...instance,
          ...(instance.implicit && current
            ? {
                label: current.instance.label,
                shortLabel: current.instance.shortLabel,
                badgeColor: current.instance.badgeColor,
              }
            : {}),
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
  /**
   * Check every saved account's home, one at a time, each committed as it answers. A home that
   * hasn't answered within the patience stays checking while the next account's check starts, so
   * one stuck folder holds up only its own account (ADR 0175).
   */
  canonicalizeHomes(signal?: AbortSignal, options: HomeCheckOptions = {}): Promise<void> {
    const check = options.check ?? ((instance, next) => next(instance));
    const after = options.after ?? realAfter;
    const patienceMs = options.patienceMs ?? homeCheckPatienceMs;
    const roots = new Map<string, Set<string>>();
    const settled: Promise<void>[] = [];
    let turn: Promise<void> = Promise.resolve();
    // The CLIs' own logins touch no folder: checked first, they never wait behind a silent one.
    const accounts = this.readAccounts().toSorted(
      (a, b) => Number(!a.instance.implicit) - Number(!b.instance.implicit),
    );
    for (const account of accounts) {
      if (this.pending.has(account.instance.id)) continue;
      const mine = turn.then(() => this.checkHome(account, roots, check, signal));
      this.checks.set(account.instance.id, mine);
      settled.push(mine);
      // Patience runs from when this check starts, not from when it was queued.
      turn = turn.then(() => withinPatience(mine, patienceMs, after));
    }
    this.firstPass = turn;
    this.ready = Promise.all(settled).then(() => {});
    // Consumers can use readiness later; prevent an unhandled failure meanwhile.
    void this.ready.catch(() => undefined);
    for (const task of settled) void task.catch(() => undefined);
    return this.ready;
  }
  private async checkHome(
    account: { instance: ProviderInstance; quota: AccountQuota },
    roots: Map<string, Set<string>>,
    check: NonNullable<HomeCheckOptions["check"]>,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    signal?.throwIfAborted();
    const blockers = { ...account.quota.blockers };
    delete blockers.homeUnavailable;
    let instance = account.instance;
    try {
      instance = await check(account.instance, (next) => readHome(next, this.managedDataDir));
      // A home shared with an account that answered first is the later one's conflict.
      if ((instance.provider !== "acp" || instance.managed) && !instance.implicit) {
        const used = roots.get(instance.provider) ?? new Set<string>();
        const selectors = new Set([instance.homeDir, ...Object.values(instance.env)]);
        for (const path of selectors) if (used.has(path)) throw new Error("home_conflict");
        for (const path of selectors) used.add(path);
        roots.set(instance.provider, used);
      }
    } catch (error) {
      signal?.throwIfAborted();
      instance = account.instance;
      blockers.homeUnavailable = homeProblem(error);
    }
    signal?.throwIfAborted();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Removed while its home was being read: nothing left to record.
      const current = this.readAccount(instance.id);
      if (current)
        this.upsert.run(
          instance.id,
          JSON.stringify({
            ...instance,
            label: current.instance.label,
            shortLabel: current.instance.shortLabel,
            badgeColor: current.instance.badgeColor,
          }),
          JSON.stringify({ ...current.quota, blockers }),
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.checks.delete(instance.id);
    for (const listener of this.quotaListeners) {
      try {
        listener(instance.id);
      } catch {
        /* Reader owns delivery. */
      }
    }
  }
  /** CLI-owned login completed; invalidate only this immutable account generation. */
  loginChanged(id: string): void {
    const account = this.readAccount(id);
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
  /**
   * An installed ACP agent confirmed authentication; arbitrary ACP frames stay opaque. A sign-in
   * remembers the agent's method, so a session it refuses for want of one can select it again.
   */
  recordAcpAuth(
    id: string,
    auth: "logged_in" | "logged_out",
    observedAt: number,
    signInMethod?: string,
  ): void {
    const account = this.readAccount(id);
    if (!account || account.instance.provider !== "acp") throw new Error("ACP account required");
    const quota = AccountQuota.parse({ ...account.quota, auth, observedAt });
    this.loginChanged(id);
    this.updateQuota.run(JSON.stringify(quota), id);
    if (auth === "logged_out") this.clearSignInMethod.run(id);
    else if (signInMethod) this.setSignInMethod.run(id, signInMethod.slice(0, 128));
    for (const listener of this.quotaListeners) {
      try {
        listener(id);
      } catch {
        /* Reader owns delivery. */
      }
    }
  }
  /** How an Antigravity account signed in, for its Settings row; nothing for other accounts. */
  private antigravitySignIn(instance: ProviderInstance) {
    if (accountProvider(instance) !== "antigravity") return {};
    const method = antigravitySignInOf(this.acpSignInMethod(instance.id));
    return method ? { antigravitySignIn: method } : {};
  }
  /** The ACP method the person last signed in with, while they stay signed in. */
  acpSignInMethod(id: string): string | undefined {
    const remembered = this.signInMethod.get(id);
    return typeof remembered?.method === "string" ? remembered.method : undefined;
  }
  /** Why a usage read found nothing to report (fixed words), or undefined once it reads again. */
  recordUsageNotice(id: string, notice: AccountQuota["usageNotice"]): void {
    const account = this.readAccount(id);
    if (!account) throw new Error("Unknown instance");
    const before = account.quota.usageNotice;
    if (before?.message === notice?.message && before?.reason === notice?.reason) return;
    const quota = AccountQuota.parse({ ...account.quota, usageNotice: notice });
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
    const account = this.readAccount(id);
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
  /** An executable changed: its saved identity no longer proves the current CLI is signed in. */
  invalidateAuth(id: string, expectedRevision: string): boolean {
    const account = this.readAccount(id);
    if (!account || (account.instance.loginRevision ?? "0") !== expectedRevision) return false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.recordAuth(id, "unknown");
      this.loginChanged(id);
      this.updateQuota.run(
        JSON.stringify(AccountQuota.parse({ ...account.quota, auth: "unknown" })),
        id,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    for (const listener of this.quotaListeners) {
      try {
        listener(id);
      } catch {
        /* Reader owns delivery. */
      }
    }
    return true;
  }
  ingest(id: string, fact: QuotaFact) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const account = this.readAccount(id);
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
        windows: readings(account.quota.windows),
        blockers: account.quota.blockers,
        auth: account.quota.auth,
        billingMode: account.quota.billingMode,
        plan: account.quota.plan,
        resetCredits: account.quota.resetCredits,
      };
      const after = {
        windows: readings(result.state.windows),
        blockers: result.state.blockers,
        auth: result.state.auth,
        billingMode: result.state.billingMode,
        plan: result.state.plan,
        resetCredits: result.state.resetCredits,
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
  /** The account new threads of one ACP agent use, when the person chose one. */
  selectedAcp(acpAgentId: string): string | undefined {
    const value = this.selection.get(acpSelectionKey(acpAgentId));
    return value ? AccountInstanceId.parse(value.instance_id) : undefined;
  }
  selectAcp(acpAgentId: string, id: string): void {
    const instance = this.get(id)?.instance;
    if (this.pending.has(id) || instance?.provider !== "acp" || instance.acpAgentId !== acpAgentId)
      throw new Error("Provider mismatch");
    this.setSelection.run(acpSelectionKey(acpAgentId), id);
  }
  rename(
    id: string,
    label: string,
    badge: {
      shortLabel?: string | undefined;
      badgeUsesInitial?: boolean | undefined;
      badgeColor?: ProviderInstance["badgeColor"] | null | undefined;
      /** A curated icon in place of letters; null goes back to letters. */
      badgeIcon?: ProviderInstance["badgeIcon"] | null | undefined;
    } = {},
  ): void {
    const account = this.readAccount(id);
    if (!account) throw new Error("Unknown account");
    if (badge.shortLabel !== undefined) AccountBadgeInput.parse(badge.shortLabel);
    this.upsert.run(
      id,
      JSON.stringify(
        ProviderInstance.parse({
          ...account.instance,
          label,
          shortLabel: badge.badgeUsesInitial
            ? undefined
            : (badge.shortLabel ?? account.instance.shortLabel),
          badgeColor:
            badge.badgeColor === null
              ? undefined
              : (badge.badgeColor ?? account.instance.badgeColor),
          badgeIcon:
            badge.badgeIcon === null ? undefined : (badge.badgeIcon ?? account.instance.badgeIcon),
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
      this.clearSignInMethod.run(id);
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
          ...this.antigravitySignIn(account.instance),
          isDefault:
            account.instance.provider === "acp"
              ? this.acpDefault(account.instance, (key) => {
                  const value = this.selection.get(key);
                  return value ? AccountInstanceId.parse(value.instance_id) : undefined;
                })
              : (this.selectedProvider(account.instance.provider) ??
                  (account.instance.provider === "cursor"
                    ? (this.selectedCursorSdk() ?? cursorDefaultInstanceId)
                    : `${account.instance.provider}-cli-default`)) === id,
        }
      : undefined;
  }
  /**
   * Whether new threads of an ACP agent use this account: the one the person chose for that
   * agent, else the agent CLI's own login.
   */
  private acpDefault(
    instance: ProviderInstance,
    selected: (key: string) => string | undefined,
  ): boolean {
    const chosen = instance.acpAgentId ? selected(acpSelectionKey(instance.acpAgentId)) : undefined;
    return chosen === undefined ? instance.homeStrategy !== "managed" : chosen === instance.id;
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
        Object.assign(summarize(account, now), this.antigravitySignIn(account.instance), {
          isDefault:
            account.instance.provider === "acp"
              ? this.acpDefault(account.instance, (key) => selected.get(key))
              : (selected.get(`provider:${account.instance.provider}`) ??
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
  homeChecks: HomeCheckOptions = {},
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
  const registry = new AccountRegistry(new DatabaseSync(path), managedDataDir);
  registry.canonicalizeHomes(signal, homeChecks);
  return registry;
}

/**
 * The index with every saved home checked, except any that hasn't answered: those read as
 * `home_checking` and keep being checked, so a silent folder never holds up the caller (the
 * `ace accounts` CLI, tools).
 */
export async function openRegistry(
  path: string,
  managedDataDir: string = dirname(path),
  homeChecks: HomeCheckOptions = {},
): Promise<AccountRegistry> {
  const registry = await openRegistryIndex(path, undefined, managedDataDir, homeChecks);
  await registry.firstPass;
  return registry;
}

/** Windows as readers see them: a repeated reading that only moves its read time is no change. */
function readings(windows: AccountQuota["windows"]) {
  return Object.fromEntries(
    Object.entries(windows).map(([name, { observedAt: _observedAt, ...window }]) => [name, window]),
  );
}
