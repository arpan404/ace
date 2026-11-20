import { z } from "zod";
import { spadeJson, spadeRecord } from "./json.ts";

/*
 * Connectors (ADR 0131, spade/docs/connectors.md): the person's apps through their own remote MCP
 * servers, as `/v1/connectors` writes them. Parsed leniently: an entry this client can't read is
 * left out. No answer carries a token, so none is parsed.
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
}

/**
 * Why a connector signed in through Spade Cloud can't renew its sign-in now. It keeps working
 * until its token expires.
 */
export type SpadeCloudNotice = "cloud_unreachable" | "ace_signed_out" | "ace_unreachable";

export type SpadeConnectorState =
  | "connected"
  | "connecting"
  | "unreachable"
  | "needs_reconnect"
  | "signing_in";

export interface SpadeConnector {
  id: string;
  name: string;
  url: string;
  catalogue: string | undefined;
  /** The person marked it as a server on their own machine or network. */
  local: boolean;
  /** How it is signed in: `oauth`, `token` or `none`. */
  signIn: "oauth" | "token" | "none";
  state: SpadeConnectorState;
  /** The account it is signed in as, when the app said. */
  account: string | undefined;
  tools: number;
  /** Why it is unreachable, in a few words. */
  problem: string | undefined;
  /** A device sign-in in progress or just ended: the code the person enters, and where. */
  device: SpadeDeviceSignIn | undefined;
  /** `cloud`: signs in through Spade Cloud. */
  via: "cloud" | undefined;
  notice: SpadeCloudNotice | undefined;
  /** The bots allowed to use it, by id, in roster order (Spade's while it is on). */
  bots: string[];
  /** When a bot last ran one of its tools, ms since the epoch (to the minute). */
  lastUsedMs: number | undefined;
  /** Why its last sign-in in the browser failed, lately. */
  failed: SpadeSignInFailure | undefined;
}

/**
 * Why a sign-in in the browser failed: the person declined or closed it, the account needs an
 * admin's approval, it took too long, it came back from the wrong server, or something else.
 */
export type SpadeSignInFailure = "declined" | "needs_admin" | "expired" | "wrong_server" | "failed";

/**
 * A device sign-in (RFC 8628, ADR 0137): the person types `code` on the app's page at `url`
 * while Spade waits for them.
 */
export interface SpadeDeviceSignIn {
  code: string;
  url: string;
  state: "waiting" | "expired" | "denied" | "failed";
}

/** `GET /v1/connectors`. */
export interface SpadeConnectors {
  catalogue: SpadeCatalogueEntry[];
  connectors: SpadeConnector[];
}

/** What connecting answered: connected at once, or a sign-in to open in the browser. */
export type SpadeConnectStart =
  | { kind: "connected"; connector: SpadeConnector }
  | { kind: "sign_in"; id: string; url: string }
  /** A device sign-in: nothing opens; the connector's row shows the code. */
  | { kind: "device"; id: string; code: string; url: string };

/** Which connectors a bot may use. */
export interface SpadeConnectorAccess {
  all: boolean;
  connectors: string[];
}

const text = z.string().nullish().catch(undefined);
const signIns = ["oauth", "oauth_client", "token"] as const;
const states = ["connected", "connecting", "unreachable", "needs_reconnect", "signing_in"] as const;
const via = z.literal("cloud").nullish().catch(undefined);
const notices = ["cloud_unreachable", "ace_signed_out", "ace_unreachable"] as const;

const categories = spadeAppCategories.map((each) => each.id);
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
  key_url: z
    .string()
    .regex(/^https:\/\//i)
    .optional()
    .catch(undefined),
});

function entryOf(raw: unknown): SpadeCatalogueEntry | undefined {
  const parsed = entryShape.safeParse(raw);
  if (!parsed.success) return undefined;
  const entry = parsed.data;
  const signIn = entry.sign_in.filter((kind): kind is SpadeSignIn =>
    (signIns as readonly unknown[]).includes(kind),
  );
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
  };
}

/** What an older Spade, which doesn't say, allows: its best way in. */
function readyOf(signIn: readonly SpadeSignIn[]): SpadeAppReady {
  if (signIn.includes("oauth")) return "sign_in";
  return signIn.includes("token") ? "key" : "later";
}

const connectorShape = z.object({
  id: z.string().min(1),
  name: text,
  url: z.string().catch(""),
  catalogue: text,
  local: z.boolean().catch(false).default(false),
  sign_in: z.enum(["oauth", "token", "none"]).catch("none"),
  // A state this client doesn't know reads as still connecting, never as connected.
  state: z.enum(states).catch("connecting"),
  account: text,
  tools: z.number().int().nonnegative().catch(0).default(0),
  problem: text,
  device: z.unknown().optional(),
  via,
  // A notice this client doesn't know is left out: the row then reads as it would without one.
  notice: z.enum(notices).nullish().catch(undefined),
  bots: z.array(z.unknown()).catch([]).default([]),
  last_used_ms: z.number().int().nonnegative().nullish().catch(undefined),
  // A reason this client doesn't know reads as the general one.
  failed: z
    .enum(["declined", "needs_admin", "expired", "wrong_server", "failed"])
    .nullish()
    .catch("failed"),
});

/** A sign-in page the browser may open: https, or http on this machine's loopback. */
const signInPage = /^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/)/i;

/** Only https: the page goes straight to the person's browser. */
const webPage = z.string().regex(/^https:\/\//i);

const deviceShape = z.object({
  code: z.string().min(1).max(64),
  url: webPage,
  // A state this client doesn't know reads as still waiting.
  state: z.enum(["waiting", "expired", "denied", "failed"]).catch("waiting"),
});

function deviceOf(raw: unknown): SpadeDeviceSignIn | undefined {
  const parsed = deviceShape.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** One connector value; undefined without an id. */
export function parseSpadeConnectorValue(raw: unknown): SpadeConnector | undefined {
  const parsed = connectorShape.safeParse(raw);
  if (!parsed.success) return undefined;
  const connector = parsed.data;
  return {
    id: connector.id,
    name: connector.name || connector.id,
    url: connector.url,
    catalogue: connector.catalogue || undefined,
    local: connector.local,
    signIn: connector.sign_in,
    state: connector.state,
    account: connector.account || undefined,
    tools: connector.tools,
    problem: connector.problem || undefined,
    device: deviceOf(connector.device),
    via: connector.via ?? undefined,
    notice: connector.notice ?? undefined,
    bots: connector.bots.filter((each): each is string => typeof each === "string"),
    lastUsedMs: connector.last_used_ms ?? undefined,
    failed: connector.failed ?? undefined,
  };
}

function listOf<T>(raw: unknown, read: (item: unknown) => T | undefined): T[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const value = read(item);
    return value === undefined ? [] : [value];
  });
}

/** `GET /v1/connectors`; undefined when the body isn't an object. */
export function parseSpadeConnectors(body: string): SpadeConnectors | undefined {
  const record = spadeRecord(spadeJson(body));
  if (!record) return undefined;
  return {
    catalogue: listOf(record.catalogue, entryOf),
    connectors: listOf(record.connectors, parseSpadeConnectorValue),
  };
}

/** `{"connector": …}`. */
export function parseSpadeConnector(body: string): SpadeConnector | undefined {
  return parseSpadeConnectorValue(spadeRecord(spadeJson(body))?.connector);
}

/** What `POST /v1/connectors` or `…/{id}/connect` answered. */
export function parseSpadeConnectStart(body: string): SpadeConnectStart | undefined {
  const record = spadeRecord(spadeJson(body));
  if (!record) return undefined;
  const connector = parseSpadeConnectorValue(record.connector);
  if (connector) return { kind: "connected", connector };
  const url = record.sign_in_url;
  // Only https, or http on this machine (a server the person marked as their own, which Spade
  // alone lets sign in there): the address goes straight to the person's browser.
  if (typeof record.id === "string" && typeof url === "string" && signInPage.test(url))
    return { kind: "sign_in", id: record.id, url };
  const device = deviceOf({ ...spadeRecord(record.device), state: "waiting" });
  if (typeof record.id === "string" && device)
    return { kind: "device", id: record.id, code: device.code, url: device.url };
  return undefined;
}

/** `GET` or `PUT /v1/agents/{id}/connectors`. */
export function parseSpadeConnectorAccess(body: string): SpadeConnectorAccess | undefined {
  const record = spadeRecord(spadeJson(body));
  if (!record || typeof record.all !== "boolean") return undefined;
  const ids = Array.isArray(record.connectors)
    ? record.connectors.filter((id): id is string => typeof id === "string")
    : [];
  return { all: record.all, connectors: ids };
}

/** A connector's state in a few words, for its row. */
export function spadeConnectorLine(connector: SpadeConnector): string {
  if (connector.device) return spadeDeviceLine(connector.name, connector.device);
  switch (connector.state) {
    case "connected":
      return connector.account ? `Connected as ${connector.account}` : "Connected";
    case "connecting":
      return "Connecting";
    case "signing_in":
      return "Waiting for you to finish signing in";
    case "needs_reconnect":
      return "Signed out";
    case "unreachable":
      return connector.problem ? `Can't reach it: ${connector.problem}` : "Can't reach it";
  }
}

/**
 * The quiet line of a connector signed in through Spade Cloud: that it does, or why it can't
 * renew now. Undefined for every other connector.
 */
export function spadeCloudLine(connector: SpadeConnector): string | undefined {
  if (connector.via !== "cloud") return undefined;
  switch (connector.notice) {
    case "cloud_unreachable":
      return "Spade Cloud can't be reached. It keeps working until its sign-in runs out.";
    case "ace_signed_out":
      return "Sign in to ace to keep it signed in through Spade Cloud.";
    case "ace_unreachable":
      return "ace can't be reached to renew its sign-in. It keeps working until then.";
    case undefined:
      return "Signs in through Spade Cloud";
  }
}

/** A device sign-in in one sentence: the code to enter, or why it ended. */
export function spadeDeviceLine(app: string, device: SpadeDeviceSignIn): string {
  switch (device.state) {
    case "waiting":
      return `Enter ${device.code} on ${app}'s page to finish signing in.`;
    case "expired":
      return "The code expired before it was entered.";
    case "denied":
      return `The sign-in was declined on ${app}.`;
    case "failed":
      return `${app} didn't finish the sign-in.`;
  }
}

/** What a failed sign-in to `app` means, with what fixes it, in one sentence. */
export function spadeSignInFailureWords(app: string, failure: SpadeSignInFailure): string {
  switch (failure) {
    case "declined":
      return `The sign-in to ${app} was cancelled. Connect again when you're ready.`;
    case "needs_admin":
      return `${app} says your account needs admin approval. Ask your admin to allow Spade, then connect again.`;
    case "expired":
      return "The sign-in took too long. Connect again.";
    case "wrong_server":
      return `That sign-in didn't come back from ${app}, so Spade ignored it. Connect again.`;
    case "failed":
      return `${app} didn't finish the sign-in. Try again in a minute.`;
  }
}

/** Whether a connected app works, in a word for Settings › Apps: Working or Needs reconnect. */
export function spadeConnectorHealth(connector: SpadeConnector): string {
  switch (connector.state) {
    case "connected":
      return "Working";
    case "needs_reconnect":
      return "Needs reconnect";
    case "signing_in":
      return "Waiting for you to finish signing in";
    case "connecting":
      return "Connecting";
    case "unreachable":
      return connector.problem ? `Can't reach it: ${connector.problem}` : "Can't reach it";
  }
}

/** When a bot last used an app, in words: "Used just now", "Used 3 hours ago", "Not used yet". */
export function spadeLastUsedWords(lastUsedMs: number | undefined, nowMs: number): string {
  if (lastUsedMs === undefined) return "Not used yet";
  const minutes = Math.max(0, Math.floor((nowMs - lastUsedMs) / 60_000));
  if (minutes < 2) return "Used just now";
  if (minutes < 60) return `Used ${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Used ${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  return `Used ${days} ${days === 1 ? "day" : "days"} ago`;
}

/** `GET /v1/connectors/fit`: the catalogue apps that fit a need, best first, by id. */
export function parseSpadeAppsFit(body: string): string[] | undefined {
  const apps = spadeRecord(spadeJson(body))?.apps;
  return Array.isArray(apps)
    ? apps.filter((each): each is string => typeof each === "string")
    : undefined;
}
