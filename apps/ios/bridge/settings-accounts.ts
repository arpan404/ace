import type { ClientCore } from "@ace/client";
import {
  ApiKeyUpstream,
  type AntigravitySignIn,
  type ApiKeySupport as ApiKeySupportSchema,
  type ProviderAccountSummary,
} from "@ace/protocol";
import {
  AccountBadgeColor,
  AccountBadgeIcon,
  ManagedAccountProvider,
} from "@ace/protocol/accounts";
import {
  accountBadgePreview,
  accountStatus,
  accountView,
  antigravitySignIn,
  antigravitySignInLabel,
  antigravitySignInMethods,
  apiKeyServiceLabel,
  providerNames,
  type AccountBadgePreview,
} from "@ace/ui-core";
import { z } from "zod";

/*
 * A provider's accounts on the phone, as the web's Settings manages them: each account's badge,
 * state and what can be done with it; every way the daemon can add one (`provider.accounts.add`
 * with a browser login, an API key, an OpenCode service or an Antigravity sign-in method); sign
 * in again the same ways (`provider.accounts.reauth`); and on remove, whether the account's
 * files can go too. The live badge preview for the editor is here as well. Swift draws.
 */

const badge = {
  shortLabel: z.string().max(64).default(""),
  color: AccountBadgeColor.optional(),
  icon: AccountBadgeIcon.optional(),
};
const way = z.object({
  method: z.enum(["login", "api_key"]),
  upstream: ApiKeyUpstream.optional(),
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
]);
export type AccountsScreenRequest = z.infer<typeof AccountsScreenRequest>;
type Provider = z.infer<typeof ManagedAccountProvider>;
type ApiKeySupport = z.infer<typeof ApiKeySupportSchema>;

/** One way to add an account or sign one in again, as a row the person picks. */
export interface AccountWay {
  id: string;
  label: string;
  method: "login" | "api_key";
  upstream: string | null;
  signIn: "google" | "enterprise" | "agent_platform" | null;
  /** Asks for a Google Cloud project and location. */
  cloud: boolean;
  /** What happens next, once, under the choice. */
  next: string;
}

/** Every way the daemon offers to add an account for this provider. */
export function accountWays(provider: Provider, support: ApiKeySupport): AccountWay[] {
  const name = providerNames[provider];
  const base = { upstream: null, signIn: null, cloud: false } as const;
  const login = (next: string): AccountWay => ({
    ...base,
    id: "login",
    label: "Sign in with the browser",
    method: "login",
    next,
  });
  if (provider === "antigravity")
    return antigravitySignInMethods.map((entry) => ({
      ...base,
      id: entry.method,
      label: entry.label,
      method: "login",
      signIn: entry.method,
      cloud: entry.cloud,
      next: entry.cloud
        ? "Name the Google Cloud project and location the account uses."
        : `ace opens ${name}'s own Google sign-in. Your password stays with Google.`,
    }));
  if (provider === "opencode")
    return [
      login(
        "ace opens OpenCode's sign-in terminal on the connected computer. Finish its prompts there.",
      ),
    ];
  const ways = [
    login(
      `ace opens ${name}'s own sign-in in your browser. Your password and tokens stay with ${name}; ace never sees them.`,
    ),
  ];
  if (support.supported)
    ways.push({
      ...base,
      id: "api_key",
      label: `Use ${apiKeyServiceLabel(provider)} API key`,
      method: "api_key",
      next: `Next, paste the key. ${name} stores it; ace hands it over once and never saves it.`,
    });
  return ways;
}

/** Ways to sign an existing account in again: the browser, then each API key the CLI takes. */
export function reauthWays(provider: Provider, support: ApiKeySupport): AccountWay[] {
  const ways = accountWays(provider, support).map((entry) =>
    entry.method === "login" && !entry.signIn ? { ...entry, label: "Sign in again" } : entry,
  );
  if (provider !== "opencode" || !support.supported) return ways;
  return [
    ...ways,
    ...(support.upstreams ?? []).flatMap((upstream): AccountWay[] => {
      const parsed = ApiKeyUpstream.safeParse(upstream);
      return parsed.success
        ? [
            {
              id: `api_key:${parsed.data}`,
              label: `Use ${apiKeyServiceLabel("opencode", parsed.data)} API key`,
              method: "api_key",
              upstream: parsed.data,
              signIn: null,
              cloud: false,
              next: "Next, paste the key. OpenCode stores it; ace never saves it.",
            },
          ]
        : [];
    }),
  ];
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
      fields: {
        method: "login" | "api_key";
        upstream?: z.infer<typeof ApiKeyUpstream>;
        signIn?: AntigravitySignIn;
      };
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
  return {
    fields: { method: input.method, ...(input.upstream ? { upstream: input.upstream } : {}) },
  };
}

export async function answerAccountsScreen(
  owner: Owner,
  request: AccountsScreenRequest,
  signal: AbortSignal,
  now: number,
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
    const screen: AccountsScreen = {
      provider: request.provider,
      name: providerNames[request.provider],
      accounts: reply.result.accounts.map((entry) => accountRow(entry, request.provider, now)),
      ways: accountWays(request.provider, reply.result.apiKey),
      reauth: reauthWays(request.provider, reply.result.apiKey),
    };
    return { ok: true, screen };
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
