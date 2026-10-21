import type { Check } from "@ace/diagnostics";
import {
  accountPorts,
  readAccountFacts,
  type AccountFact,
  type AccountFacts,
  type AccountPorts,
} from "./accounts-facts.ts";
import type { DoctorContext, DoctorFeature } from "./feature.ts";

const providerNames: Record<string, string> = {
  codex: "Codex",
  claude: "Claude",
  cursor: "Cursor",
  opencode: "OpenCode",
  pi: "Pi",
  acp: "ACP",
};
const folderWords: Record<NonNullable<AccountFact["homeUnavailable"]>, string> = {
  home_missing: "its folder is missing",
  home_unreadable: "its folder can't be read",
  foreign_home: "its folder belongs to another ace installation",
  home_conflict: "its folder is shared with another account",
};
const maxListed = 8;
const foldersFix =
  "Open Settings › Providers, sign in to the account again or remove it. If it keeps happening, run ace triage.";
const signInFix =
  "Sign in again from Settings › Providers. For a provider's default account, its own CLI login works too.";

/**
 * Every configured provider account, not only each CLI's default login: missing account
 * folders and lapsed sign-ins. The base checks already probe each CLI's own login, so this
 * reads what ace knows per account and never opens a provider's credential files.
 */
export function accountsFeature(ports: AccountPorts = accountPorts): DoctorFeature {
  return {
    id: "accounts",
    checks(context) {
      let facts: Promise<AccountFacts> | undefined;
      const load = () => (facts ??= readAccountFacts(context, ports));
      return [foldersCheck(context, load), signInCheck(context, load)];
    },
  };
}

export const accounts: DoctorFeature = accountsFeature();

function foldersCheck(context: DoctorContext, load: () => Promise<AccountFacts>): Check {
  return {
    id: "accounts.folders",
    fix: foldersFix,
    async run() {
      const facts = await load();
      if (facts.source === "none")
        return { status: "ok", message: "No accounts recorded yet", fix: foldersFix };
      const problems = facts.accounts.flatMap((account) =>
        account.homeUnavailable ? [{ account, reason: account.homeUnavailable }] : [],
      );
      const unreadable = facts.source === "file" ? facts.unreadable : 0;
      if (!problems.length && !unreadable)
        return {
          status: "ok",
          message: `${count(facts.accounts.length, "account")}, every folder available${asOf(facts, context)}`,
          fix: foldersFix,
        };
      const lines = listed(
        problems.map(({ account, reason }) => `${name(account)}: ${folderWords[reason]}`),
      );
      if (unreadable) lines.push(`${count(unreadable, "account record")} couldn't be read`);
      return {
        status: "warn",
        message: `Account folder unavailable for ${problems.length} of ${count(facts.accounts.length, "account")}${asOf(facts, context)}:\n${lines.join("\n")}`,
        fix: foldersFix,
      };
    },
  };
}

function signInCheck(context: DoctorContext, load: () => Promise<AccountFacts>): Check {
  return {
    id: "accounts.sign-in",
    fix: signInFix,
    async run() {
      const facts = await load();
      if (facts.source === "none")
        return { status: "ok", message: "No accounts recorded yet", fix: signInFix };
      // A missing folder is reported once, by the folders check.
      const usable = facts.accounts.filter((account) => !account.homeUnavailable);
      const problems = usable.filter(
        (account) => account.auth === "logged_out" || account.usageNotice,
      );
      if (!problems.length) {
        const signedIn = usable.filter((account) => account.auth === "logged_in").length;
        const unknown = usable.length - signedIn;
        return {
          status: "ok",
          message:
            `${count(signedIn, "account")} signed in` +
            (unknown ? `, ${unknown} not checked yet` : "") +
            asOf(facts, context),
          fix: signInFix,
        };
      }
      const lines = listed(
        problems.map(
          (account) =>
            `${name(account)}: ${account.auth === "logged_out" ? "signed out" : account.usageNotice}`,
        ),
      );
      return {
        status: "warn",
        message: `${count(problems.length, "account")} need${problems.length === 1 ? "s" : ""} signing in again${asOf(facts, context)}:\n${lines.join("\n")}`,
        fix: signInFix,
      };
    },
  };
}

function name(account: AccountFact): string {
  const provider = providerNames[account.provider] ?? account.provider;
  return `${provider} “${account.label}” (${account.id})`;
}

/** At most eight lines of at most 200 characters, so the message stays in the report's bound. */
function listed(lines: string[]): string[] {
  const clipped = lines
    .slice(0, maxListed)
    .map((line) => (line.length > 200 ? `${line.slice(0, 199)}…` : line));
  return lines.length > maxListed ? [...clipped, `…and ${lines.length - maxListed} more`] : clipped;
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

/** Stored facts are as old as the daemon's last reading; live facts need no caveat. */
function asOf(facts: AccountFacts, context: DoctorContext): string {
  if (facts.source !== "file") return "";
  const latest = Math.max(0, ...facts.accounts.map((account) => account.observedAt));
  if (!latest) return " (as ace last saw them)";
  return ` (as ace last saw them, ${ago(context.now() - latest)})`;
}

function ago(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}
