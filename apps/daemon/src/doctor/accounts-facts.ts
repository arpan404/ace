import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { AccountQuota, ProviderInstance, type AccountSummary } from "@ace/protocol/accounts";
import type { DoctorContext } from "./feature.ts";

/** What doctor needs to know about one configured account instance. */
export type AccountFact = {
  id: string;
  provider: string;
  label: string;
  auth: AccountQuota["auth"];
  homeUnavailable?: NonNullable<AccountQuota["blockers"]["homeUnavailable"]>;
  usageNotice?: string;
  observedAt: number;
};

/**
 * Where the facts came from: the running daemon's live view, or the account index it last
 * wrote (read-only, so doctor works while ace is stopped). `unreadable` counts rows that
 * didn't parse; they're reported, never fatal.
 */
export type AccountFacts =
  | { source: "daemon"; accounts: AccountFact[] }
  | { source: "file"; accounts: AccountFact[]; unreadable: number }
  | { source: "none" };

export type AccountPorts = {
  /** The daemon's account summaries; undefined when it's down or doesn't answer. */
  live(context: DoctorContext): Promise<readonly AccountSummary[] | undefined>;
  /** The account index on disk; `none` when there isn't one yet. */
  stored(context: DoctorContext): AccountFacts;
};

export const accountPorts: AccountPorts = {
  live: (context) =>
    context.daemon(
      async (client, signal) =>
        (await client.request({ type: "accounts.list" }, { signal })).accounts,
    ),
  stored: (context) =>
    readStoredAccounts(
      context.env["ACE_ACCOUNTS_DB"] ?? join(context.config.dataDir, "accounts.sqlite"),
    ),
};

export async function readAccountFacts(
  context: DoctorContext,
  ports: AccountPorts,
): Promise<AccountFacts> {
  const live = context.daemonState === "running" ? await ports.live(context) : undefined;
  if (live)
    return {
      source: "daemon",
      accounts: live.map((summary) =>
        fact(summary.id, summary.provider, summary.label, summary.quota),
      ),
    };
  return ports.stored(context);
}

function fact(id: string, provider: string, label: string, quota: AccountQuota): AccountFact {
  return {
    id,
    provider,
    label,
    auth: quota.auth,
    ...(quota.blockers.homeUnavailable ? { homeUnavailable: quota.blockers.homeUnavailable } : {}),
    ...(quota.usageNotice ? { usageNotice: quota.usageNotice.message } : {}),
    observedAt: quota.observedAt,
  };
}

const AccountRow = z.object({ instance: z.string(), quota: z.string() });
const PendingRow = z.object({ id: z.string() });

/**
 * Reads the account index the daemon keeps, opened read-only so a broken or stopped ace is
 * never changed by looking. Holds no credentials: instances name folders, quota holds facts.
 */
export function readStoredAccounts(path: string): AccountFacts {
  if (!existsSync(path)) return { source: "none" };
  const db = new DatabaseSync(path, { readOnly: true, timeout: 200 });
  try {
    const pending = new Set<string>();
    try {
      for (const value of db.prepare("SELECT id FROM pending_accounts LIMIT 257").all()) {
        const row = PendingRow.safeParse(value);
        if (row.success) pending.add(row.data.id);
      }
    } catch {
      // An older index has no pending table; every account in it is settled.
    }
    const accounts: AccountFact[] = [];
    let unreadable = 0;
    for (const value of db
      .prepare("SELECT instance, quota FROM accounts ORDER BY id LIMIT 257")
      .all()) {
      const parsed = parseRow(value);
      if (!parsed) unreadable++;
      else if (!pending.has(parsed.instance.id))
        accounts.push(
          fact(parsed.instance.id, parsed.instance.provider, parsed.instance.label, parsed.quota),
        );
    }
    return { source: "file", accounts, unreadable };
  } finally {
    db.close();
  }
}

function parseRow(value: unknown) {
  const row = AccountRow.safeParse(value);
  if (!row.success) return undefined;
  try {
    const instance = ProviderInstance.safeParse(JSON.parse(row.data.instance));
    const quota = AccountQuota.safeParse(JSON.parse(row.data.quota));
    return instance.success && quota.success
      ? { instance: instance.data, quota: quota.data }
      : undefined;
  } catch {
    return undefined;
  }
}
