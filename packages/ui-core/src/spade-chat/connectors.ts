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
  /** `cloud`: signs in through Spade Cloud with the person's ace account (ADR 0139). */
  via: "cloud" | undefined;
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
}

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

const entryShape = z.object({
  id: z.string().min(1),
  name: text,
  url: z.string().min(1),
  sign_in: z.array(z.unknown()).catch([]).default([]),
  notes: text,
  via,
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
    via: entry.via ?? undefined,
  };
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
});

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
  // Only https: the address goes straight to the person's browser.
  if (typeof record.id === "string" && typeof url === "string" && /^https:\/\//i.test(url))
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
