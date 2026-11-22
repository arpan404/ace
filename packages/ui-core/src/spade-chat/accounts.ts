import { z } from "zod";
import { spadeJson, spadeRecord } from "./json.ts";
import { parseSpadeEndpointValue, type SpadeEndpoint, type SpadePreset } from "./endpoints.ts";

/*
 * Providers and their accounts (ADR 0213): every endpoint is an account of a provider, the preset
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
  if (!usedBy.length) return undefined;
  if (usedBy.length === 1) return `Used by ${usedBy[0]}`;
  if (usedBy.length > 4)
    return `Used by ${usedBy.slice(0, 3).join(", ")} and ${usedBy.length - 3} more`;
  return `Used by ${usedBy.slice(0, -1).join(", ")} and ${usedBy.at(-1)}`;
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

/** The one plain sentence shown before a ChatGPT sign-in starts (ADR 0213 §5). */
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
