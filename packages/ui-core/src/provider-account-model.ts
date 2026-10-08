import { availability } from "@ace/accounts/availability";
import type { ProviderKind, ProviderStatus } from "@ace/protocol";
import type { AccountView } from "./accounts.ts";
import {
  readinessView,
  type CatalogSignal,
  type ReadinessTone,
  type ReadinessView,
} from "./provider-readiness.ts";

export interface AccountStatusView {
  tone: ReadinessTone;
  text: string;
  canRun: boolean;
}

/** Authentication and live limits in the same words on every account surface. */
export function accountStatus(account: AccountView, now: number): AccountStatusView {
  if (account.runtimeStatus && !account.runtimeStatus.canRun) return account.runtimeStatus;
  if (account.quota.auth !== "logged_in" && account.runtimeStatus?.canRun) {
    const limits = availability({ ...account.quota, auth: "logged_in" }, now);
    if (limits === "exhausted") return { tone: "problem", text: "Limit reached", canRun: false };
    if (limits === "near_limit") return { tone: "action", text: "Near its limit", canRun: true };
    return account.runtimeStatus;
  }
  switch (availability(account.quota, now)) {
    case "logged_out":
      return { tone: "action", text: "Signed out", canRun: false };
    case "unknown":
      if (account.runtimeStatus) return account.runtimeStatus;
      return { tone: "idle", text: "Sign-in not reported", canRun: false };
    case "exhausted":
      return { tone: "problem", text: "Limit reached", canRun: false };
    case "near_limit":
      return { tone: "action", text: "Near its limit", canRun: true };
    case "available":
      return { tone: "ready", text: "Signed in", canRun: true };
  }
}

export interface ProviderAccountModel {
  accounts: AccountView[];
  view: ReadinessView | undefined;
  /** Missing reads must not briefly advertise a sign-in problem. */
  loaded: boolean;
}

/**
 * Discovery describes only the normal CLI profile. It can clarify that account, never an
 * isolated account. Quota windows and blockers survive authentication reconciliation.
 * A usable sibling wins over a signed-out default; an exhausted login is still signed in.
 */
export function providerAccountModel(input: {
  provider: ProviderKind;
  acpAgentId?: string | undefined;
  accounts: readonly AccountView[] | undefined;
  row?: ProviderStatus | undefined;
  catalog?: CatalogSignal | undefined;
  now: number;
}): ProviderAccountModel {
  const base = input.row && readinessView(input.row, input.catalog);
  const own = (input.accounts ?? []).filter(
    (account) =>
      account.provider === input.provider &&
      account.id !== "cursor-cli-default" &&
      (input.provider !== "acp" || account.acpAgentId === input.acpAgentId),
  );
  const accounts: AccountView[] = [];
  for (const account of own) {
    if (base?.state === "not_installed" || base?.state === "off") {
      accounts.push({
        ...account,
        runtimeStatus: { tone: base.tone, text: base.label, canRun: false },
      });
      continue;
    }
    if (!account.implicit || !input.row || input.row.installed !== true) {
      accounts.push(account);
      continue;
    }
    const auth = input.row.auth;
    const quota = auth === "unknown" ? account.quota : { ...account.quota, auth };
    accounts.push({
      ...account,
      label: input.row.accountLabel ?? account.label,
      quota,
      signedIn: quota.auth === "logged_in",
      runtimeStatus:
        (quota.auth === "unknown" ||
          base?.state === "attention" ||
          (quota.auth === "logged_out" && base?.ready && base.upstreams)) &&
        base
          ? { tone: base.tone, text: base.ready ? "Ready" : base.label, canRun: base.ready }
          : undefined,
      availability: availability(quota, input.now),
    });
  }
  accounts.sort((a, b) => Number(Boolean(b.implicit)) - Number(Boolean(a.implicit)));
  const loaded =
    input.accounts !== undefined && (input.provider === "acp" || input.row !== undefined);
  if (!loaded) return { accounts, loaded, view: undefined };
  // Missing or disabled runtimes cannot run any of their accounts.
  if (base?.state === "not_installed" || base?.state === "off")
    return { accounts, loaded, view: base };
  const usable = accounts.filter((account) => accountStatus(account, input.now).canRun);
  const runnable = usable.find((account) => account.implicit) ?? usable[0];
  // Model evidence is only a fallback for an unreported normal-profile login, not a quota bypass.
  if (runnable || (base?.ready && !accounts.length)) {
    const label = runnable ? accountStatus(runnable, input.now).text : (base?.label ?? "Ready");
    const summary =
      runnable?.implicit && runnable.quota.auth === "logged_in" && input.row?.accountLabel
        ? `Signed in as ${input.row.accountLabel}`
        : runnable
          ? label
          : (base?.summary ?? "Ready");
    return {
      accounts,
      loaded,
      view: {
        ...base,
        state: "ready",
        ready: true,
        label,
        summary,
        tone: runnable ? accountStatus(runnable, input.now).tone : (base?.tone ?? "ready"),
        primary: undefined,
        more: base?.more ?? [],
      },
    };
  }
  const limited = accounts.find(
    (account) => accountStatus(account, input.now).text === "Limit reached",
  );
  if (limited)
    return {
      accounts,
      loaded,
      view: {
        state: "attention",
        ready: false,
        label: "Limit reached",
        summary: "Limit reached",
        tone: "action",
        more: [],
        detail: "No account is ready to run. Wait for the limit to reset or add another account.",
      },
    };
  if (accounts.length && accounts.every((account) => account.quota.auth === "logged_out"))
    return {
      accounts,
      loaded,
      view: {
        state: "signed_out",
        ready: false,
        label: "Signed out",
        summary: "Signed out",
        tone: "action",
        primary: "sign_in",
        more: [],
      },
    };
  return {
    accounts,
    loaded,
    view: base && {
      ...base,
      ...(base.state === "signed_out" ? { label: "Signed out", summary: "Signed out" } : {}),
    },
  };
}
