import type { ProviderKind } from "@ace/protocol";
import {
  isAddedAgentAccount,
  type AccountStatusView,
  type AccountView,
  type ReadinessView,
} from "@ace/ui-core";

/*
 * What a provider's page leads with when something needs the person: one sentence and the one
 * fix. Pure: the page passes what discovery, readiness and the default account say.
 */

/** The fix an account's row offers: sign in while it's signed out, sign in again while it fails. */
export type AccountFix = "sign_in" | "reconnect";

/** Agents reached over ACP (and Antigravity) sign in through their own ACP sign-in. */
export const agentProvider = (provider: ProviderKind) =>
  provider === "acp" || provider === "antigravity";

/**
 * Who signing in an account signs in: Antigravity's CLI login and the CLIs' own logins go
 * unnamed, any other account by its id; an agent's dialog names the agent, not "ACP agent".
 */
export function accountSignInTarget(account: AccountView, provider: ProviderKind, name: string) {
  const cliLogin =
    account.implicit || (provider === "antigravity" && !isAddedAgentAccount(account));
  return {
    provider,
    ...(agentProvider(provider) ? { name } : {}),
    ...(cliLogin ? {} : { instance: account.id }),
  };
}

export function accountFix(
  account: AccountView,
  status: AccountStatusView,
): AccountFix | undefined {
  if (status.text === "Signed out" || status.text === "Not signed in yet") return "sign_in";
  // A limit waits for its reset and a missing home folder isn't fixed by signing in.
  if (status.text !== "Limit reached" && !status.canRun && !account.quota.blockers.homeUnavailable)
    return "reconnect";
  return undefined;
}

export type ProblemFix = AccountFix | "install" | "turn_on";

export interface ProviderProblem {
  text: string;
  fix?: ProblemFix | undefined;
  /** The account the fix signs in, when the problem is the default account's. */
  account?: AccountView | undefined;
}

export function providerProblem(input: {
  provider: ProviderKind;
  name: string;
  missing: boolean;
  view: ReadinessView | undefined;
  /** The accounts list has loaded, so a missing view isn't a pending read. */
  accountsLoaded?: boolean | undefined;
  /** The default account and where it stands, once the accounts have loaded. */
  defaultAccount?: { account: AccountView; status: AccountStatusView } | undefined;
}): ProviderProblem | undefined {
  const { name, view } = input;
  if (input.missing) return { text: `${name} isn't installed on this computer.`, fix: "install" };
  if (view?.state === "off")
    return {
      text: `${name} is turned off in ace, so it won't start, sign in or list models.`,
      fix: "turn_on",
    };
  // Update sits in the header; the line says why it's needed.
  if (view?.state === "needs_update")
    return { text: view.detail ?? `${name} needs an update before it can start threads.` };
  const own = input.defaultAccount;
  const fix = own && accountFix(own.account, own.status);
  const ownProblem: ProviderProblem | undefined =
    own && fix
      ? {
          text:
            fix === "sign_in"
              ? `${own.account.label} is signed out, so new threads can't start on it.`
              : `${own.account.label} needs you to sign in again before new threads can start on it.`,
          fix,
          account: own.account,
        }
      : undefined;
  // The provider's own words for a sign-in problem lead; the fix signs in its default account.
  if (view && !view.ready && (view.state === "signed_out" || view.state === "attention")) {
    // A limit has no fix but its reset; sign-in problems name theirs.
    const viewFix =
      view.primary === "sign_in" || view.primary === "reconnect" ? view.primary : undefined;
    return {
      text:
        view.detail ??
        ownProblem?.text ??
        (view.state === "signed_out" ? `${name} is signed out.` : `${name} needs attention.`),
      fix: ownProblem?.fix ?? viewFix,
      account: ownProblem?.account,
    };
  }
  if (ownProblem) return ownProblem;
  // An agent that reports nothing yet signs in through its own ACP sign-in.
  if (!view && input.accountsLoaded && agentProvider(input.provider))
    return { text: `Sign in to ${name} to use it.`, fix: "sign_in" };
  if (!view || view.ready) return undefined;
  switch (view.state) {
    case "unconfirmed":
      if (agentProvider(input.provider))
        return { text: `Sign in to ${name} to use it.`, fix: "sign_in" };
      return view.detail ? { text: view.detail } : undefined;
    default:
      return undefined;
  }
}
