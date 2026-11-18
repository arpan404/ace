import {
  ACE_CLIENT_DEVELOPMENT,
  ACE_CLIENT_HEADER,
  ACE_CLIENT_PARAM,
  AceClient,
  AceClientApp,
} from "@ace/protocol/ace-client";
import { isNewer } from "./version.ts";

/**
 * Server features gated by the calling app's version (ADR 0189). Pure: the Workers of ace cloud
 * and the market read the caller once per request or upgrade and ask `supports`.
 *
 * Gating is about compatibility, never authorization: any caller can claim any version, so a
 * gated feature must be safe to serve to anyone who asks for it.
 */

/** Who is calling, as read from `ace-client` (ADR 0189). */
export type ClientIdentity =
  | { kind: "release"; app: AceClientApp; version: string }
  /** A build that isn't a release: the owner's own, run from a checkout. */
  | { kind: "development"; app: AceClientApp }
  /** No value, or one this server can't read: an older app, or someone else's client. */
  | { kind: "unknown" };

export const unknownClient: ClientIdentity = { kind: "unknown" };

/** A client identity from an `ace-client` value. Anything missing or garbled is unknown. */
export function parseClient(value: string | null | undefined): ClientIdentity {
  const parsed = AceClient.safeParse(value);
  if (!parsed.success) return unknownClient;
  const slash = parsed.data.indexOf("/");
  const app = AceClientApp.safeParse(parsed.data.slice(0, slash));
  if (!app.success) return unknownClient;
  const version = parsed.data.slice(slash + 1);
  return version === ACE_CLIENT_DEVELOPMENT
    ? { kind: "development", app: app.data }
    : { kind: "release", app: app.data, version };
}

/**
 * The client any request or upgrade names: the `ace-client` header, else the `ace-client` query
 * parameter, which browsers use (a WebSocket upgrade can't set headers, and a custom header on
 * a cross-origin call needs a preflight). A header that is present wins even when it is
 * garbled, so a URL can't override what the caller's own client said.
 */
export function clientOf(request: { headers: Headers; url: string }): ClientIdentity {
  const header = request.headers.get(ACE_CLIENT_HEADER);
  if (header !== null) return parseClient(header);
  let param: string | null = null;
  try {
    param = new URL(request.url).searchParams.get(ACE_CLIENT_PARAM);
  } catch {
    return unknownClient;
  }
  return parseClient(param);
}

/**
 * The first version of each app that understands a feature. Apps keep their own version lines
 * (the iPhone app's is not the desktop's), so each app names its own minimum; an app that isn't
 * listed doesn't get the feature. A beta's version orders before its stable release (ADR 0177),
 * so a feature first shipped in `0.0.24-beta.1` is on for later betas and for 0.0.24 and up.
 */
export type FeatureMinimums = Readonly<Partial<Record<AceClientApp, string>>>;
export type FeatureTable = Readonly<Record<string, FeatureMinimums>>;

/**
 * The gated features of ace cloud and the market. Add an entry when a server change needs a
 * client that understands it; remove it, and the gate, once the oldest app either server still
 * serves is past every minimum here (ADR 0189). Empty: nothing is gated yet.
 */
export const SERVER_FEATURES = {} as const satisfies FeatureTable;

/** What a handler asks of the caller. */
export interface FeatureGate<Feature extends string> {
  readonly client: ClientIdentity;
  supports(feature: Feature): boolean;
}

/**
 * Whether `client` gets a feature with these minimums. A release at or past its app's minimum
 * does; a development build does (it is the owner's own, built from main, which is ahead of
 * every release); an unknown client is treated as the oldest app and doesn't.
 */
export function meetsMinimums(client: ClientIdentity, minimums: FeatureMinimums): boolean {
  if (client.kind === "unknown") return false;
  const minimum = minimums[client.app];
  if (minimum === undefined) return false;
  if (client.kind === "development") return true;
  return !isNewer(minimum, client.version);
}

/** The gate for one request or connection. */
export function featureGate<Table extends FeatureTable>(
  table: Table,
  client: ClientIdentity,
): FeatureGate<Extract<keyof Table, string>> {
  return {
    client,
    supports: (feature) => {
      const minimums = table[feature];
      return minimums !== undefined && meetsMinimums(client, minimums);
    },
  };
}

/** The gate for the servers' own table. */
export const serverGate = (client: ClientIdentity) => featureGate(SERVER_FEATURES, client);
export type ServerFeature = Extract<keyof typeof SERVER_FEATURES, string>;
export type ServerGate = FeatureGate<ServerFeature>;
