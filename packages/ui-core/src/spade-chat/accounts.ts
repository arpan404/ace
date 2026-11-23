import { z } from "zod";
import { pluralCount } from "../counts.ts";
import { formatResets } from "../limit-words.ts";
import type { ReadinessTone } from "../provider-readiness.ts";
import { spadeJson, spadeRecord } from "./json.ts";
import { parseSpadeEndpointValue, type SpadeEndpoint, type SpadePreset } from "./endpoints.ts";

/*
 * Providers and their accounts (ADR 0214): every endpoint is an account of a provider, the preset
 * it was made from or its own address. A ChatGPT sign-in is an account of OpenAI that Spade signs
 * in to itself, through a flow the client starts and reads until it ends.
 */

/** One provider and its accounts, in the order Spade lists them. */
export interface SpadeProviderGroup {
  /** The preset id; for an account added by its address, `address:<account id>`. */
  key: string;
  /** The preset id; undefined for an account added by its address. */
  provider: string | undefined;
  /** The service's plain name ("OpenAI"), or the account's own name for an address. */
  name: string;
  accounts: SpadeEndpoint[];
}

/** Providers Spade knows by name even without a preset of that id in the list. */
const knownNames: Record<string, string> = { openai: "OpenAI" };

/** A preset's name without the wire format it is written in. */
const plainName = (name: string) => name.replace(/\s*\([^()]*\bformat\)\s*$/i, "").trim() || name;

/**
 * The person's accounts by provider: one group per provider in the order its first account
 * comes, each account in Spade's order. An account added by its address is its own provider.
 */
export function spadeProviderGroups(
  endpoints: readonly SpadeEndpoint[],
  presets: readonly SpadePreset[],
): SpadeProviderGroup[] {
  const groups = new Map<string, SpadeProviderGroup>();
  for (const endpoint of endpoints) {
    const key = endpoint.provider ?? `address:${endpoint.id}`;
    const group = groups.get(key);
    if (group) {
      group.accounts.push(endpoint);
      continue;
    }
    groups.set(key, {
      key,
      provider: endpoint.provider,
      name: spadeProviderName(endpoint.provider, presets) ?? endpoint.name,
      accounts: [endpoint],
    });
  }
  return [...groups.values()];
}

/**
 * A provider's plain name: its preset's, else one Spade knows; undefined for neither (its
 * group then goes by its first account's name).
 */
export function spadeProviderName(
  provider: string | undefined,
  presets: readonly SpadePreset[],
): string | undefined {
  if (!provider) return undefined;
  const preset = presets.find((each) => each.id === provider);
  if (preset) return plainName(preset.name);
  return knownNames[provider];
}

/** A ChatGPT plan as people say it: "plus" reads "Plus". */
const planWords = (plan: string) => plan.charAt(0).toUpperCase() + plan.slice(1);

/**
 * How an account signs in, in words: its key (saved or not, never shown), that it needs none,
 * or who the ChatGPT sign-in is ("Signed in as sam@example.com · Plus") or that it is signed out.
 */
export function spadeAccountWords(endpoint: SpadeEndpoint, keychain: boolean): string {
  if (endpoint.auth === "chatgpt") {
    const account = endpoint.account;
    if (!account?.signedIn) return "Signed out";
    const who = account.email ? `Signed in as ${account.email}` : "Signed in";
    return account.plan ? `${who} · ${planWords(account.plan)}` : who;
  }
  if (!endpoint.needsKey) return "Needs no key";
  if (endpoint.keySet === undefined) return "Checking the keychain…";
  if (endpoint.keySource === "environment") return "From the environment";
  if (!keychain) return "Set its environment variable where Spade runs";
  return endpoint.keySet ? "Saved in the keychain" : "Not saved";
}

/**
 * Which bots think with an account: "Used by Inbox and Ledger", past three names "Used by Audit,
 * Inbox, Ledger and 4 more"; undefined for none.
 */
export function spadeUsedByWords(usedBy: readonly string[]): string | undefined {
  const names = spadeBotNames(usedBy);
  return names && `Used by ${names}`;
}

/** Bots by name: "Inbox and Ledger", past four "Audit, Inbox, Ledger and 4 more". */
function spadeBotNames(names: readonly string[]): string | undefined {
  if (!names.length) return undefined;
  if (names.length === 1) return names[0];
  if (names.length > 4) return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** What fixes an account that can't take work: its key, or signing in again. */
export type SpadeAccountFix = "key" | "sign_in";

/** Where an account stands, in a word or two and the tone it shows in. */
export interface SpadeAccountState {
  tone: ReadinessTone;
  text: string;
  fix?: SpadeAccountFix | undefined;
}

/**
 * Where an account stands now: signed out or without its key (the person's to fix), at its
 * plan's usage limit until a time (as ace's accounts say it; it lifts by itself, so it asks
 * nothing), the keychain still answering, or ready. A key is pasted only where there's a keychain.
 */
export function spadeAccountState(
  endpoint: SpadeEndpoint,
  keychain: boolean,
  now: number,
): SpadeAccountState {
  if (endpoint.auth === "chatgpt") {
    if (!endpoint.account?.signedIn) return { tone: "action", text: "Signed out", fix: "sign_in" };
    const until = endpoint.account.limitedUntil;
    if (until !== undefined && until > now)
      return { tone: "problem", text: `Limit reached · ${formatResets(until, now).toLowerCase()}` };
    return { tone: "ready", text: "Ready" };
  }
  if (!endpoint.needsKey) return { tone: "ready", text: "Ready" };
  if (endpoint.keySet === undefined) return { tone: "idle", text: "Checking the keychain…" };
  if (!endpoint.keySet)
    return { tone: "action", text: "Key missing", ...(keychain ? { fix: "key" as const } : {}) };
  return { tone: "ready", text: "Ready" };
}

/**
 * A provider's line on the Models list: its one account's state; with several, the first one
 * the person must fix (by name), how many sit at a usage limit, or ready.
 */
export function spadeProviderState(
  accounts: readonly SpadeEndpoint[],
  keychain: boolean,
  now: number,
): SpadeAccountState {
  const states = accounts.map((account) => spadeAccountState(account, keychain, now));
  if (states.length === 1 && states[0]) return states[0];
  const blocked = states.findIndex((state) => state.tone === "action");
  const first = accounts[blocked];
  const needs = states[blocked];
  if (first && needs) return { ...needs, text: `${first.name}: ${needs.text.toLowerCase()}` };
  const limited = states.filter((each) => each.text.startsWith("Limit reached")).length;
  if (limited === states.length && states[0]) return states[0];
  if (limited) return { tone: "idle", text: `${limited} at the usage limit` };
  return { tone: "ready", text: "Ready" };
}

/**
 * How many bots think with a provider: a bot's model is on one account, so each account's bots
 * add up. Two bots may share a name, so names aren't merged.
 */
export function spadeProviderBots(accounts: readonly SpadeEndpoint[]): number {
  return accounts.reduce((sum, account) => sum + account.usedBy.length, 0);
}

/** The first thing on a provider's page when one of its accounts needs the person. */
export interface SpadeProviderProblem {
  account: SpadeEndpoint;
  fix: SpadeAccountFix;
  text: string;
}

/**
 * The account the person must fix first, in one sentence that says what it costs them: the bots
 * that can't run until then ("Add a key so Digest and Triage can run."). Undefined when every
 * account can take work, or waits only on a limit that lifts by itself.
 */
export function spadeProviderProblem(
  accounts: readonly SpadeEndpoint[],
  keychain: boolean,
  now: number,
): SpadeProviderProblem | undefined {
  for (const account of accounts) {
    const fix = spadeAccountState(account, keychain, now).fix;
    if (!fix) continue;
    const bots = spadeBotNames(account.usedBy);
    const to = accounts.length > 1 ? ` to ${account.name}` : "";
    const text =
      fix === "key"
        ? bots
          ? `Add a key${to} so ${bots} can run.`
          : `Add a key${to} so bots can use it.`
        : bots
          ? `${account.name} is signed out, so ${bots} can't run.`
          : `${account.name} is signed out. Sign in again to use it.`;
    return { account, fix, text };
  }
  return undefined;
}

/** "3 accounts · 31 bots": a provider's size, for its line on the list. */
export function spadeProviderCounts(accounts: readonly SpadeEndpoint[]): string {
  const bots = spadeProviderBots(accounts);
  const parts = accounts.length > 1 ? [pluralCount(accounts.length, "account")] : [];
  if (bots) parts.push(pluralCount(bots, "bot"));
  return parts.join(" · ");
}

/**
 * What a picker calls each account: its name, and where two share one, the name with its id
 * ("OpenAI (work)"), so two accounts of a provider can be told apart.
 */
export function spadeAccountLabels(endpoints: readonly SpadeEndpoint[]): Map<string, string> {
  const count = new Map<string, number>();
  for (const endpoint of endpoints) count.set(endpoint.name, (count.get(endpoint.name) ?? 0) + 1);
  return new Map(
    endpoints.map((endpoint) => [
      endpoint.id,
      (count.get(endpoint.name) ?? 0) > 1 ? `${endpoint.name} (${endpoint.id})` : endpoint.name,
    ]),
  );
}

export type SpadeSignInMethod = "browser" | "device";
export type SpadeSignInState = "waiting" | "done" | "failed" | "cancelled";

/** A ChatGPT sign-in Spade is running (`POST /v1/accounts/chatgpt`). */
export interface SpadeSignInFlow {
  id: string;
  method: SpadeSignInMethod;
  state: SpadeSignInState;
  /** Where the person signs in: a browser link, or the page the device code is entered on. */
  url: string | undefined;
  /** The device code to enter at `url`; undefined for a browser sign-in. */
  userCode: string | undefined;
  /** Once done: the account signed in. */
  endpoint: SpadeEndpoint | undefined;
  /** Once failed: why, in one line. */
  error: string | undefined;
}

/** The one plain sentence shown before a ChatGPT sign-in starts (ADR 0214 §5). */
export const spadeChatgptTerms =
  "Using a ChatGPT sign-in outside OpenAI's own Codex apps may go against OpenAI's terms; you " +
  "sign in knowing that.";

const text = z.string().nullish().catch(undefined);
const flowShape = z.object({
  id: z.string().min(1),
  method: z.enum(["browser", "device"]).catch("browser"),
  // A state this client doesn't know is read as still waiting; the sign-in ends in 15 minutes.
  state: z.enum(["waiting", "done", "failed", "cancelled"]).catch("waiting"),
  url: text,
  user_code: text,
  endpoint: z.unknown().optional(),
  error: text,
});

/** `{"flow": ...}` from starting or reading a sign-in; undefined without one. */
export function parseSpadeSignInFlow(body: string): SpadeSignInFlow | undefined {
  const parsed = flowShape.safeParse(spadeRecord(spadeJson(body))?.flow);
  if (!parsed.success) return undefined;
  const flow = parsed.data;
  return {
    id: flow.id,
    method: flow.method,
    state: flow.state,
    url: flow.url || undefined,
    userCode: flow.user_code || undefined,
    endpoint: parseSpadeEndpointValue(flow.endpoint),
    error: flow.error || undefined,
  };
}
