import type { ClientCore } from "@ace/client";
import {
  ApiKeyUpstream,
  type AntigravitySignIn,
  type ApiKeySupport,
  type ProviderAccountSummary,
} from "@ace/protocol";
import {
  AccountBadgeColor,
  AccountBadgeIcon,
  ManagedAccountProvider,
} from "@ace/protocol/accounts";
import {
  accountBadgePreview,
  apiKeyServiceLabel,
  accountStatus,
  accountView,
  antigravitySignIn,
  antigravitySignInLabel,
  antigravitySignInMethods,
  providerNames,
  type AccountBadgePreview,
} from "@ace/ui-core";
import { z } from "zod";
import { directLinkProblem } from "./provider-key.ts";

/*
 * A provider's accounts on the phone, as the web's Settings manages them: each account's badge,
 * state and what can be done with it; every sign-in way the daemon offers to add one
 * (`provider.accounts.add` with a browser login, OpenCode's sign-in terminal or an Antigravity
 * sign-in method); sign in again the same ways (`provider.accounts.reauth`); and on remove,
 * whether the account's files can go too. The live badge preview for the editor is here as well.
 *
 * A provider that takes API keys also offers a key, one way per service when the daemon lists
 * them, handed to the CLI only over the relay's encrypted `provider_auth` channel
 * (`provider-key.ts`, ADR 0002). A phone that reaches its machine directly can't hand one over,
 * so it gets one fixed line saying where keys are added instead. Swift draws.
 */

const badge = {
  shortLabel: z.string().max(64).default(""),
  color: AccountBadgeColor.optional(),
  icon: AccountBadgeIcon.optional(),
};
const way = z.object({
  signIn: z.enum(["google", "enterprise", "agent_platform"]).optional(),
  project: z.string().max(128).default(""),
  location: z.string().max(64).default(""),
});
export const AccountsScreenRequest = z.discriminatedUnion("type", [
  z.object({ type: z.literal("accounts.screen"), provider: ManagedAccountProvider }),
  z.object({ type: z.literal("accounts.screen.badge"), label: z.string().max(256), ...badge }),
  z.object({
    type: z.literal("accounts.screen.add"),
    provider: ManagedAccountProvider,
    label: z.string().max(256),
    shortLabel: z.string().max(64).default(""),
    way,
  }),
  z.object({
    type: z.literal("accounts.screen.reauth"),
    provider: ManagedAccountProvider,
    instanceId: z.string().min(1).max(128),
    way,
  }),
  z.object({
    type: z.literal("accounts.screen.act"),
    provider: ManagedAccountProvider,
    instanceId: z.string().min(1).max(128),
    action: z.enum(["setDefault", "remove", "removeWithFiles"]),
  }),
  z.object({
    type: z.literal("accounts.screen.rename"),
    provider: ManagedAccountProvider,
    instanceId: z.string().min(1).max(128),
    label: z.string().max(256),
    ...badge,
  }),
]);
export type AccountsScreenRequest = z.infer<typeof AccountsScreenRequest>;
type Provider = z.infer<typeof ManagedAccountProvider>;

/** One way to add an account or sign one in again, as a row the person picks. */
export interface AccountWay {
  id: string;
  label: string;
  signIn: "google" | "enterprise" | "agent_platform" | null;
  /** Asks for a Google Cloud project and location. */
  cloud: boolean;
  /** What happens next, once, under the choice. */
  next: string;
}

/** Every sign-in way the daemon offers to add an account for this provider. */
export function accountWays(provider: Provider): AccountWay[] {
  const name = providerNames[provider];
  if (provider === "antigravity")
    return antigravitySignInMethods.map((entry) => ({
      id: entry.method,
      label: entry.label,
      signIn: entry.method,
      cloud: entry.cloud,
      next: entry.cloud
        ? "Name the Google Cloud project and location the account uses."
        : `ace opens ${name}'s own Google sign-in. Your password stays with Google.`,
    }));
  return [
    {
      id: "login",
      label: "Sign in with the browser",
      signIn: null,
      cloud: false,
      next:
        provider === "opencode"
          ? "ace opens OpenCode's sign-in terminal on the connected computer. Finish its prompts there."
          : `ace opens ${name}'s own sign-in in your browser. Your password and tokens stay with ${name}; ace never sees them.`,
    },
  ];
}

/** Ways to sign an existing account in again: the same sign-in ways, never a key. */
export function reauthWays(provider: Provider): AccountWay[] {
  const ways = accountWays(provider);
  for (const entry of ways) if (!entry.signIn) entry.label = "Sign in again";
  return ways;
}

/** One way to add an account with a pasted API key (`accounts.screen.key`). */
export interface KeyWay {
  id: string;
  label: string;
  /** The service the key is for, when the provider routes to several (Pi). */
  upstream: z.infer<typeof ApiKeyUpstream> | null;
  next: string;
}

/** Providers whose key hand-off fails without the service it's for (`upstream`). */
const needsUpstream = new Set<Provider>(["pi"]);

/**
 * The key ways the daemon reports for this provider, the same capability the web reads. OpenCode
 * takes keys in its own sign-in terminal and Antigravity signs in with Google, as on the web.
 * Pi stores a key only for a named service, so it offers none until the daemon lists services.
 */
export function keyWays(provider: Provider, support: z.infer<typeof ApiKeySupport>): KeyWay[] {
  if (!support.supported || provider === "opencode" || provider === "antigravity") return [];
  const name = providerNames[provider];
  const offer = (upstream: KeyWay["upstream"]): KeyWay => {
    const service = apiKeyServiceLabel(provider, upstream ?? undefined);
    return {
      id: upstream ? `api_key:${upstream}` : "api_key",
      label: upstream ? `${service} API key` : "API key",
      upstream,
      next: `Paste your ${service} API key. ${name} stores it; ace hands it over once through ace's relay and never saves it.`,
    };
  };
  const upstreams = (support.upstreams ?? []).flatMap((entry) => {
    const parsed = ApiKeyUpstream.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
  if (upstreams.length) return upstreams.map(offer);
  return needsUpstream.has(provider) ? [] : [offer(null)];
}

/** The line for a provider that takes keys when this phone can't hand one over: it's direct. */
export function apiKeyLine(ways: KeyWay[], relayed: boolean): string | null {
  return ways.length && !relayed ? directLinkProblem : null;
}

/** Agents whose sign-in ace removes along with the account, and whose files can go too. */
const signsOut = new Set<Provider>(["codex", "claude", "cursor", "antigravity"]);

export interface AccountRow {
  id: string;
  label: string;
  signedInAs: string | null;
  isDefault: boolean;
  /** "Signed in", "Limit reached", "Signed out"… */
  state: string;
  tone: "ready" | "action" | "problem" | "idle";
  needsSignIn: boolean;
  /** "API key", "Gemini Enterprise": how it signs in, when that says something. */
  method: string | null;
  badge: AccountBadgePreview;
  /** The badge letters as typed; empty when it follows the name's initial. */
  typedBadge: string;
  canMakeDefault: boolean;
  removable: boolean;
  /** The account has its own folder on the machine that remove can delete. */
  canDeleteFiles: boolean;
  /** The removal confirmation's words. */
  removeMessage: string;
}

export function accountRow(
  summary: ProviderAccountSummary,
  provider: Provider,
  now: number,
): AccountRow {
  const view = accountView(summary);
  const state = accountStatus(view, now);
  const apiKey = summary.authMethod === "api_key";
  const needsSignIn =
    state.text === "Signed out" ||
    state.text === "Not signed in yet" ||
    (state.text !== "Limit reached" && !state.canRun && !view.quota.blockers.homeUnavailable);
  const removable = !summary.implicit && summary.homeStrategy !== "default_cli";
  const typed = summary.badgeUsesInitial ? "" : (summary.shortLabel ?? "");
  return {
    id: summary.id,
    label: summary.label,
    signedInAs: summary.signedInAs ?? null,
    isDefault: summary.isDefault === true,
    state: state.text,
    tone: state.tone,
    needsSignIn,
    method: apiKey
      ? "API key"
      : summary.antigravitySignIn
        ? antigravitySignInLabel(summary.antigravitySignIn)
        : null,
    badge: accountBadgePreview({
      label: summary.label,
      shortLabel: typed,
      color: summary.badgeColor,
      icon: summary.badgeIcon,
    }),
    typedBadge: typed,
    canMakeDefault: !summary.isDefault && !needsSignIn,
    removable,
    canDeleteFiles: removable && signsOut.has(provider),
    removeMessage:
      (apiKey ? "ace never stored your API key. " : "") +
      (signsOut.has(provider)
        ? `This removes the account from ace and ${apiKey ? "the CLI's stored key" : "its stored sign-in"}. Sign in again to add it back.`
        : `This removes the account from ace. ${apiKey ? "The key stays in the CLI's credential store" : "Its sign-in stays with the CLI"}; remove it through the CLI if needed.`),
  };
}

export interface AccountsScreen {
  provider: Provider;
  name: string;
  accounts: AccountRow[];
  ways: AccountWay[];
  reauth: AccountWay[];
  /** Ways to add an account with an API key; empty when the daemon offers none or can't here. */
  keyWays: KeyWay[];
  /** Why keys can't be added from this phone, for a provider that takes them. */
  apiKey: string | null;
}

type Owner = Pick<ClientCore, "request">;
type Reply = { ok: true; [key: string]: unknown } | { ok: false; problem: string };

const failures: Record<string, string> = {
  forbidden: "This device can't change accounts. Use the computer running ace.",
  busy: "Another sign-in is running. Finish it, then try again.",
  not_found: "That account is gone. Pull to refresh.",
  unsupported: "This provider can't do that.",
};
const failure = (error: string | undefined): Reply => ({
  ok: false,
  problem:
    failures[error ?? ""] ?? "Couldn't update accounts. Check the machine connection and retry.",
});

/** The `provider.accounts.add`/`reauth` fields for a chosen way, or what to fix first. */
function chosen(
  provider: Provider,
  input: z.infer<typeof way>,
):
  | {
      fields: { method: "login"; signIn?: AntigravitySignIn };
    }
  | { problem: string } {
  if (provider === "antigravity") {
    const picked = antigravitySignIn({
      method: input.signIn ?? "google",
      project: input.project,
      location: input.location,
    });
    if ("problem" in picked) return picked;
    return { fields: { method: "login" as const, signIn: picked.signIn } };
  }
  return { fields: { method: "login" } };
}

export async function answerAccountsScreen(
  owner: Owner,
  request: AccountsScreenRequest,
  signal: AbortSignal,
  now: number,
  /** The phone reaches this machine through ace's relay, where a key may go. */
  relayed = false,
): Promise<Reply> {
  if (request.type === "accounts.screen.badge")
    return {
      ok: true,
      badge: accountBadgePreview({
        label: request.label,
        shortLabel: request.shortLabel,
        color: request.color,
        icon: request.icon,
      }),
    };
  const options = { signal, timeoutMs: 20_000 };
  if (request.type === "accounts.screen") {
    const reply = await owner.request(
      { type: "provider.accounts.list", provider: request.provider },
      options,
    );
    if (!reply.result.ok) return failure(reply.result.error);
    const offered = keyWays(request.provider, reply.result.apiKey);
    const screen: AccountsScreen = {
      provider: request.provider,
      name: providerNames[request.provider],
      accounts: reply.result.accounts.map((entry) => accountRow(entry, request.provider, now)),
      ways: accountWays(request.provider),
      reauth: reauthWays(request.provider),
      keyWays: relayed ? offered : [],
      apiKey: apiKeyLine(offered, relayed),
    };
    return { ok: true, screen };
  }
  if (request.type === "accounts.screen.act") {
    const target = { provider: request.provider, instanceId: request.instanceId };
    const reply = await owner.request(
      request.action === "setDefault"
        ? { type: "provider.accounts.setDefault", ...target }
        : {
            type: "provider.accounts.remove",
            ...target,
            confirm: true,
            deleteHome: request.action === "removeWithFiles",
          },
      options,
    );
    return reply.result.ok ? { ok: true } : failure(reply.result.error);
  }
  if (request.type === "accounts.screen.rename") {
    const label = request.label.trim();
    if (!label) return { ok: false, problem: "Give the account a name, like Work." };
    const preview = accountBadgePreview({
      label,
      shortLabel: request.shortLabel,
      color: request.color,
      icon: request.icon,
    });
    if (preview.problem) return { ok: false, problem: preview.problem };
    const reply = await owner.request(
      {
        type: "provider.accounts.rename",
        provider: request.provider,
        instanceId: request.instanceId,
        label,
        ...(preview.save.shortLabel ? { shortLabel: preview.save.shortLabel } : {}),
        badgeUsesInitial: preview.save.badgeUsesInitial,
        badgeColor: preview.save.badgeColor,
        badgeIcon: preview.save.badgeIcon,
      },
      options,
    );
    return reply.result.ok ? { ok: true } : failure(reply.result.error);
  }
  const picked = chosen(request.provider, request.way);
  if ("problem" in picked) return { ok: false, problem: picked.problem };
  if (request.type === "accounts.screen.add") {
    const label = request.label.trim();
    if (!label) return { ok: false, problem: "Give the account a name, like Work." };
    const preview = accountBadgePreview({ label, shortLabel: request.shortLabel });
    if (preview.problem) return { ok: false, problem: preview.problem };
    const reply = await owner.request(
      {
        type: "provider.accounts.add",
        provider: request.provider,
        label,
        ...(preview.save.shortLabel ? { shortLabel: preview.save.shortLabel } : {}),
        ...picked.fields,
      },
      options,
    );
    if (!reply.result.ok) return failure(reply.result.error);
    return { ok: true, progress: reply.result.progress ?? null };
  }
  const reply = await owner.request(
    {
      type: "provider.accounts.reauth",
      provider: request.provider,
      instanceId: request.instanceId,
      ...picked.fields,
    },
    options,
  );
  if (!reply.result.ok) return failure(reply.result.error);
  return { ok: true, progress: reply.result.progress ?? null };
}
