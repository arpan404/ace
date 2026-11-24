import { z } from "zod";

/*
 * Catalogue entries and their client-ID setup steps (ADR 0131, 0193, 0197;
 * spade/config/connectors.json, spade/config/connector-setups.json), as `/v1/connectors` lists
 * them.
 */

/** How a catalogue server can be signed in to, best first. */
export type SpadeSignIn = "oauth" | "oauth_client" | "token";

/** Where a catalogue app sits in the list, in the order the list shows them. */
export const spadeAppCategories = [
  { id: "mail_chat", label: "Mail & chat" },
  { id: "meetings", label: "Meetings" },
  { id: "work", label: "Work" },
  { id: "files", label: "Files" },
  { id: "sales_support", label: "Sales & support" },
  { id: "code", label: "Code" },
  { id: "data", label: "Data" },
  { id: "money", label: "Money" },
  { id: "design", label: "Design" },
] as const;

export type SpadeAppCategory = (typeof spadeAppCategories)[number]["id"];

/**
 * Whether the person can connect a catalogue app on this build today: `sign_in` with one click,
 * `key` only with a token they make in the app, `later` not yet (it waits for the owner: a
 * registration, the maker's approval).
 */
export type SpadeAppReady = "sign_in" | "key" | "later";

export type SpadeSetupValue = "client_id" | "client_secret";

export interface SpadeSetupStep {
  text: string;
  redirect: boolean;
}

export interface SpadeAppSetup {
  where: string;
  whereLabel: string;
  steps: SpadeSetupStep[];
  values: SpadeSetupValue[];
  scopes: string[];
  source: string;
  notes: string;
  redirect: string;
}

export interface SpadeCatalogueEntry {
  id: string;
  name: string;
  url: string;
  signIn: SpadeSignIn[];
  notes: string;
  /** `cloud`: signs in through Spade Cloud with the person's ace account (ADR 0140). */
  via: "cloud" | undefined;
  category: SpadeAppCategory;
  ready: SpadeAppReady;
  /** The maker's page where the person makes a token, for apps that take one. */
  keyUrl: string | undefined;
  /** Setup steps for apps that take the person's own client ID (ADR 0197). */
  setup?: SpadeAppSetup | undefined;
}

const text = z.string().nullish().catch(undefined);
const signIns = ["oauth", "oauth_client", "token"] as const;
const via = z.literal("cloud").nullish().catch(undefined);
const httpsPage = z.string().regex(/^https:\/\//i);
const callbackPage = /^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/)/i;
const setupValues = ["client_id", "client_secret"] as const;
const categories = spadeAppCategories.map((each) => each.id);

const stepShape = z.object({
  text: z.string().min(1),
  redirect: z.boolean().catch(false).default(false),
});

const setupShape = z.object({
  where: httpsPage,
  where_label: z.string().min(1),
  steps: z.array(stepShape).min(1),
  values: z.array(z.unknown()).catch([]).default([]),
  scopes: z.array(z.unknown()).catch([]).default([]),
  source: httpsPage,
  notes: z.string().catch("").default(""),
  redirect: z.string().regex(callbackPage),
});

export function parseSpadeAppSetup(raw: unknown): SpadeAppSetup | undefined {
  const parsed = setupShape.safeParse(raw);
  if (!parsed.success) return undefined;
  const setup = parsed.data;
  return {
    where: setup.where,
    whereLabel: setup.where_label,
    steps: setup.steps,
    values: setup.values.filter((each): each is SpadeSetupValue =>
      (setupValues as readonly unknown[]).includes(each),
    ),
    scopes: setup.scopes.filter((each): each is string => typeof each === "string" && each !== ""),
    source: setup.source,
    notes: setup.notes,
    redirect: setup.redirect,
  };
}

const entryShape = z.object({
  id: z.string().min(1),
  name: text,
  url: z.string().min(1),
  sign_in: z.array(z.unknown()).catch([]).default([]),
  notes: text,
  via,
  // A category this client doesn't know files the app under Work rather than dropping it.
  category: z.enum(categories).catch("work"),
  // An answer from a Spade that doesn't say: whatever its ways in allow, a sign-in first. A
  // readiness this client doesn't know reads as not ready, never as a working Sign in.
  ready: z.enum(["sign_in", "key", "later"]).optional().catch("later"),
  key_url: httpsPage.optional().catch(undefined),
  setup: z.unknown().optional(),
});

/** What an older Spade, which doesn't say, allows: its best way in. */
function readyOf(signIn: readonly SpadeSignIn[]): SpadeAppReady {
  if (signIn.includes("oauth")) return "sign_in";
  return signIn.includes("token") ? "key" : "later";
}

export function parseSpadeCatalogueEntry(raw: unknown): SpadeCatalogueEntry | undefined {
  const parsed = entryShape.safeParse(raw);
  if (!parsed.success) return undefined;
  const entry = parsed.data;
  const signIn = entry.sign_in.filter((kind): kind is SpadeSignIn =>
    (signIns as readonly unknown[]).includes(kind),
  );
  const setup = parseSpadeAppSetup(entry.setup);
  return {
    id: entry.id,
    name: entry.name || entry.id,
    url: entry.url,
    signIn,
    notes: entry.notes ?? "",
    via: entry.via ?? undefined,
    category: entry.category,
    ready: entry.ready ?? readyOf(signIn),
    keyUrl: entry.key_url,
    ...(setup ? { setup } : {}),
  };
}
