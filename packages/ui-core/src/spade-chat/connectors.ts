import { z } from "zod";
import { spadeJson, spadeRecord } from "./json.ts";

/*
 * Connectors (ADR 0131, spade/docs/connectors.md): the person's apps through their own remote MCP
 * servers, as `/v1/connectors` writes them. Parsed leniently: an entry this client can't read is
 * left out. No answer carries a token, so none is parsed.
 */

/** How a catalogue server can be signed in to, best first. */
export type SpadeSignIn = "oauth" | "oauth_client" | "token";

export interface SpadeCatalogueEntry {
  id: string;
  name: string;
  url: string;
  signIn: SpadeSignIn[];
  notes: string;
}

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
  /** How it is signed in: `oauth`, `token` or `none`. */
  signIn: "oauth" | "token" | "none";
  state: SpadeConnectorState;
  /** The account it is signed in as, when the app said. */
  account: string | undefined;
  tools: number;
  /** Why it is unreachable, in a few words. */
  problem: string | undefined;
}

/** `GET /v1/connectors`. */
export interface SpadeConnectors {
  catalogue: SpadeCatalogueEntry[];
  connectors: SpadeConnector[];
}

/** What connecting answered: connected at once, or a sign-in to open in the browser. */
export type SpadeConnectStart =
  | { kind: "connected"; connector: SpadeConnector }
  | { kind: "sign_in"; id: string; url: string };

/** Which connectors a bot may use. */
export interface SpadeConnectorAccess {
  all: boolean;
  connectors: string[];
}

const text = z.string().nullish().catch(undefined);
const signIns = ["oauth", "oauth_client", "token"] as const;
const states = ["connected", "connecting", "unreachable", "needs_reconnect", "signing_in"] as const;

const entryShape = z.object({
  id: z.string().min(1),
  name: text,
  url: z.string().min(1),
  sign_in: z.array(z.unknown()).catch([]).default([]),
  notes: text,
});

function entryOf(raw: unknown): SpadeCatalogueEntry | undefined {
  const parsed = entryShape.safeParse(raw);
  if (!parsed.success) return undefined;
  const entry = parsed.data;
  return {
    id: entry.id,
    name: entry.name || entry.id,
    url: entry.url,
    signIn: entry.sign_in.filter((kind): kind is SpadeSignIn =>
      (signIns as readonly unknown[]).includes(kind),
    ),
    notes: entry.notes ?? "",
  };
}

const connectorShape = z.object({
  id: z.string().min(1),
  name: text,
  url: z.string().catch(""),
  catalogue: text,
  sign_in: z.enum(["oauth", "token", "none"]).catch("none"),
  // A state this client doesn't know reads as still connecting, never as connected.
  state: z.enum(states).catch("connecting"),
  account: text,
  tools: z.number().int().nonnegative().catch(0).default(0),
  problem: text,
});

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
    signIn: connector.sign_in,
    state: connector.state,
    account: connector.account || undefined,
    tools: connector.tools,
    problem: connector.problem || undefined,
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
  if (typeof record.id === "string" && typeof url === "string" && /^https?:\/\//i.test(url))
    return { kind: "sign_in", id: record.id, url };
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
