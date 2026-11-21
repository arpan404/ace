import {
  GrantError,
  MARKET_GRANT_ISSUER,
  decodeBase64url,
  verifyMarketGrant,
  type MarketGrantClaims,
} from "@ace/account-grant";
import { orgAllows } from "@ace/account-grant/org-roles";
import type { MarketPublisherState } from "@ace/protocol/marketplace";
import type { Context } from "./context.ts";
import { bearer, failure } from "./http.ts";
import { liveVersionsOf } from "./store/copies.ts";
import type { Databases } from "./store/databases.ts";
import { namedPublisher, registryOf } from "./store/registries.ts";

/*
 * Who is writing (ADR 0174 §2). Every write route calls `authenticate` first: a market grant from
 * the account backend, checked for its signature, audience, purpose, lifetime and issuer, then a
 * verified email, then a recent sign-in for sensitive actions, then the publisher's state. An
 * account on the signed official list acts as the `ace` publisher (§14). Nothing else is a
 * credential here.
 */

/** How recent a sign-in a sensitive action needs: changing the handle, withdrawing, transfers. */
export const reauthMs = 10 * 60_000;

export interface AuthedPublisher {
  id: string;
  name: string;
  state: MarketPublisherState;
  created: number;
  liveVersions: number;
  verified: boolean;
  /** This is the `ace` publisher, and the account is on the signed official list. */
  official: boolean;
}

export interface Authed {
  claims: MarketGrantClaims;
  /** The WorkOS account id the grant names. */
  account: string;
  /**
   * The account's publisher; absent before it makes a profile. For a grant acting in an
   * organization (`org: "publisher"`), the organization's registry publisher.
   */
  publisher: AuthedPublisher | undefined;
  /** The organization the grant acts in (ADR 0206 §5.1), checked by the account backend. */
  org: string | undefined;
  /**
   * The grant came from the person's own session and names this very request (ADR 0190): a
   * `device` grant whose `action` is `METHOD /path <SHA-256 of the body>`, spent by this request.
   * Grants a machine holds never do.
   */
  personAction: boolean;
}

/** Base64url SHA-256. */
async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** `METHOD /path <base64url SHA-256 of the body>`, as `@ace/client/market-intent` builds it. */
async function requestIntent(method: string, path: string, body: Uint8Array): Promise<string> {
  return `${method} ${path} ${await sha256(body)}`;
}

/**
 * Marks a person's grant spent; false when it already was. Keyed by the signed claims' bytes, as
 * verified, so neither another spelling of the token nor another signature over the same claims
 * spends it again.
 */
async function spend(context: Context, token: string, expires: number): Promise<boolean> {
  const digest = await sha256(decodeBase64url(token.split(".")[0] ?? ""));
  const result = await context.dbs.publishers
    .prepare("INSERT OR IGNORE INTO spent_person_grants (digest, expires) VALUES (?1, ?2)")
    .bind(digest, expires)
    .run();
  return result.meta.changes > 0;
}

/** Why a sensitive action is refused: it needs the person's own grant for it, signed in lately. */
export const personGrantNeeded = () =>
  failure(
    401,
    "person_grant",
    "Do this from an ace app you're signed in on: it needs a sign-in from the last 10 minutes.",
  );

interface PublisherRow {
  id: string;
  name: string;
  state: string;
  created: number;
  verified: number;
}

const columns = "p.id, p.name, p.state, p.created, p.verified";

/**
 * The publisher an account writes as: the `ace` publisher for an official account, else its own.
 * Its live versions are summed over the catalogues (ADR 0174 §16). An organization's registry
 * publisher is found the same way by the organization's id, which its row keeps as `account`.
 */
async function publisherFor(dbs: Databases, account: string): Promise<AuthedPublisher | undefined> {
  const db = dbs.publishers;
  const official = await db
    .prepare(
      `SELECT ${columns} FROM official_accounts o JOIN publishers p ON p.id = o.publisher
        WHERE o.account = ?1`,
    )
    .bind(account)
    .first<PublisherRow>();
  const row =
    official ??
    (await db
      .prepare(`SELECT ${columns} FROM publishers p WHERE p.account = ?1`)
      .bind(account)
      .first<PublisherRow>());
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    // Rows this Worker wrote (ADR 0125): the column only ever holds a publisher state.
    state: row.state as MarketPublisherState,
    created: row.created,
    liveVersions: await liveVersionsOf(dbs, row.id),
    verified: row.verified === 1,
    official: official !== null,
  };
}

export interface AuthOptions {
  /** A sensitive action: the grant's sign-in must be within `reauthMs`. */
  sensitive?: boolean;
  /** Writes by a suspended or deleted publisher are refused unless this is set (reads of /v1/me). */
  allowInactive?: boolean;
  /**
   * What a grant acting in an organization may do here (ADR 0206 §5.1). Unset, it is refused:
   * the account's own profile, drafts and entries take only its own grant. `publisher`: write
   * as the organization's registry publisher, which needs `registry:publish` or an owner's
   * naming. `claims`: the route decides from the claims, with no publisher.
   */
  org?: "publisher" | "claims";
}

/** Whether an organization's grant may publish to its registry: by role, or named by an owner. */
async function mayPublishFor(dbs: Databases, claims: MarketGrantClaims, org: string) {
  if (orgAllows(claims.orgRole ?? "", "registry:publish")) return true;
  return dbs.orgs ? namedPublisher(dbs.orgs, org, claims.account) : false;
}

/** The authenticated account and its publisher, or the response refusing the request. */
export async function authenticate(
  request: Request,
  context: Context,
  options: AuthOptions = {},
): Promise<Authed | Response> {
  const token = bearer(request);
  if (!token) return failure(401, "unauthorized", "Sign in to publish.");
  const keys = await context.grantKeys.get();
  if (!keys) return failure(503, "unavailable", "Publishing can't check sign-ins right now.");
  let claims: MarketGrantClaims;
  try {
    claims = verifyMarketGrant(
      token,
      keys,
      context.now,
      context.env.ACE_GRANT_ISSUER ?? MARKET_GRANT_ISSUER,
    );
  } catch (error) {
    if (error instanceof GrantError)
      return failure(401, "unauthorized", "That sign-in isn't one for publishing.");
    throw error;
  }
  if (!claims.emailVerified)
    return failure(403, "email_unverified", "Verify your account's email to publish.");
  const url = new URL(request.url);
  // The request the grant names, target and payload both: another recipient, handle or reason
  // than the person chose makes another digest (ADR 0190).
  const personAction =
    claims.kind === "device" &&
    claims.action !== undefined &&
    claims.action ===
      (await requestIntent(
        request.method,
        url.pathname,
        new Uint8Array(await request.clone().arrayBuffer()),
      ));
  if (options.sensitive && !personAction) return personGrantNeeded();
  if (options.sensitive && !(context.now - claims.authAt <= reauthMs))
    return failure(401, "reauth", "Sign in again to do this.");
  // Once: a person's grant captured on the way and sent again does nothing.
  if (personAction && !(await spend(context, token, claims.exp)))
    return failure(401, "person_grant", "That sign-in was used already. Do it again in the app.");
  const org = claims.org;
  if (org !== undefined && options.org === undefined)
    return failure(403, "org_grant", "That sign-in acts in an organization; use your own here.");
  if (org !== undefined && options.org === "claims")
    return { claims, account: claims.account, publisher: undefined, org, personAction };
  let publisher: AuthedPublisher | undefined;
  if (org !== undefined) {
    // An organization without a registry, or one this market doesn't know, names nothing.
    const registry = await registryOf(context.dbs, org);
    if (!registry) return failure(404, "not_found", "This organization has no registry.");
    if (!(await mayPublishFor(context.dbs, claims, org)))
      return failure(
        403,
        "forbidden",
        "Publishing to this organization's registry needs the registry:publish role.",
      );
    publisher = await publisherFor(context.dbs, org);
  } else publisher = await publisherFor(context.dbs, claims.account);
  if (publisher && publisher.state !== "active" && !options.allowInactive)
    return failure(403, "suspended", "This account can't publish right now.");
  return { claims, account: claims.account, publisher, org, personAction };
}

/** The refusal for an entry another publisher owns: never says who. */
export const notYours = () => failure(403, "forbidden", "Another publisher owns this entry.");
