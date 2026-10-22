import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import type { CheckResult } from "@ace/diagnostics";
import { AccountSummary } from "@ace/protocol/accounts";
import { accountPorts } from "./accounts-facts.ts";
import { accountsFeature } from "./accounts.ts";
import type { DoctorContext } from "./feature.ts";
import { doctorTestContext } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
const signal = new AbortController().signal;
const hour = 60 * 60 * 1000;

async function verdicts(context: DoctorContext, feature = accountsFeature()) {
  const results = new Map<string, Omit<CheckResult, "id">>();
  for (const check of feature.checks(context)) results.set(check.id, await check.run(signal));
  return results;
}

function account(
  id: string,
  provider: string,
  label: string,
  quota: Record<string, unknown>,
): { id: string; instance: string; quota: string } {
  return {
    id,
    instance: JSON.stringify({ id, provider, label, homeDir: `/accounts/${id}`, env: {} }),
    quota: JSON.stringify({ windows: {}, blockers: {}, usage: {}, ...quota }),
  };
}

function writeIndex(
  dataDir: string,
  rows: { id: string; instance: string; quota: string }[],
  pending: string[],
) {
  const db = new DatabaseSync(join(dataDir, "accounts.sqlite"));
  db.exec(
    "CREATE TABLE accounts (id TEXT PRIMARY KEY, instance TEXT NOT NULL, quota TEXT NOT NULL)",
  );
  db.exec("CREATE TABLE pending_accounts (id TEXT PRIMARY KEY)");
  const insert = db.prepare("INSERT INTO accounts VALUES (?, ?, ?)");
  for (const row of rows) insert.run(row.id, row.instance, row.quota);
  for (const id of pending) db.prepare("INSERT INTO pending_accounts VALUES (?)").run(id);
  db.close();
}

it("while ace is stopped, a missing account folder and lapsed sign-ins warn from the stored index", async () => {
  const { context, dataDir, cleanup } = await doctorTestContext();
  cleanups.push(cleanup);
  const seen = context.now() - 3 * hour;
  writeIndex(
    dataDir,
    [
      account("codex-cli-default", "codex", "Codex", { auth: "logged_in", observedAt: seen }),
      account("codex-work", "codex", "Work", { auth: "logged_out", observedAt: seen }),
      account("cursor-sdk-default", "cursor", "Cursor", {
        auth: "logged_in",
        observedAt: seen,
        blockers: { homeUnavailable: "home_missing" },
      }),
      account("opencode-cli-default", "opencode", "OpenCode", {
        auth: "logged_in",
        observedAt: seen,
        usageNotice: {
          reason: "signed_out",
          message: "Sign in again in OpenCode",
          observedAt: seen,
        },
      }),
      account("codex-adding", "codex", "Being added", { auth: "logged_out", observedAt: seen }),
    ],
    ["codex-adding"],
  );
  const results = await verdicts(context);

  const folders = results.get("accounts.folders");
  expect(folders?.status).toBe("warn");
  expect(folders?.message).toContain(
    "Account folder unavailable for 1 of 4 accounts (as ace last saw them, 3 h ago)",
  );
  expect(folders?.message).toContain("Cursor “Cursor” (cursor-sdk-default): its folder is missing");

  const signIn = results.get("accounts.sign-in");
  expect(signIn?.status).toBe("warn");
  expect(signIn?.message).toContain("Codex “Work” (codex-work): signed out");
  expect(signIn?.message).toContain(
    "OpenCode “OpenCode” (opencode-cli-default): Sign in again in OpenCode",
  );
  // The folder problem is reported once, and an account still being added isn't judged.
  expect(signIn?.message).not.toContain("cursor-sdk-default");
  expect(signIn?.message).not.toContain("codex-adding");
});

it("a running daemon's live accounts are used instead of the stored index", async () => {
  const { context, cleanup } = await doctorTestContext({ daemonState: "running" });
  cleanups.push(cleanup);
  const live = AccountSummary.parse({
    id: "claude-cli-default",
    provider: "claude",
    label: "Claude",
    availability: "available",
    quota: { auth: "logged_in", observedAt: context.now(), windows: {}, blockers: {}, usage: {} },
  });
  const results = await verdicts(
    context,
    accountsFeature({
      live: async () => [live],
      stored: () => {
        throw new Error("the stored index must not be read while the daemon answers");
      },
    }),
  );
  expect(results.get("accounts.folders")).toMatchObject({
    status: "ok",
    message: "1 account, every folder available",
  });
  expect(results.get("accounts.sign-in")).toMatchObject({
    status: "ok",
    message: "1 account signed in",
  });
});

it("a daemon that doesn't answer falls back to the stored index, and no index yet is fine", async () => {
  const { context, cleanup } = await doctorTestContext({ daemonState: "running" });
  cleanups.push(cleanup);
  const results = await verdicts(
    context,
    accountsFeature({ live: async () => undefined, stored: accountPorts.stored }),
  );
  expect(results.get("accounts.folders")).toMatchObject({
    status: "ok",
    message: "No accounts recorded yet",
  });
  expect(results.get("accounts.sign-in")?.status).toBe("ok");
});
