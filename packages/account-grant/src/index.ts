import { ed25519 } from "@noble/curves/ed25519.js";
import { z } from "zod";

/**
 * Short-lived statements signed by ace's account backend (ADR 0111): "this machine" or "this
 * device" belongs to an account. Pure: no clock, network or storage. Callers pass `now`.
 */

export const GRANT_LIFETIME_MS = 5 * 60_000;
/** Accepted clock skew for a grant issued slightly in the future. */
export const GRANT_SKEW_MS = 60_000;
/** Grants reach the relay as a WebSocket subprotocol: `ace.grant.<token>`. */
export const GRANT_SUBPROTOCOL_PREFIX = "ace.grant.";
/**
 * The hosted relay's close code for a device whose account doesn't own the machine. Final: no
 * retry or new grant changes it. A machine that is merely offline closes with 1008 instead.
 */
export const NOT_YOUR_MACHINE_CLOSE = 4403;

const KeyId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const Base64url32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const GrantClaims = z.strictObject({
  v: z.literal(1),
  kid: KeyId,
  kind: z.enum(["machine", "device"]),
  /** WorkOS user id of the account. */
  account: z.string().min(1).max(256),
  /** The machine's host id, or the device's device id. */
  subject: z.string().min(1).max(128),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
});
export type GrantClaims = z.infer<typeof GrantClaims>;
export type GrantKind = GrantClaims["kind"];

/** Cloud credentials deliberately fail the relay's strict GrantClaims parser. */
export const CloudGrantClaims = GrantClaims.extend({
  kind: z.literal("machine"),
  aud: z.literal("cloud.acehq.dev"),
  purpose: z.literal("spade-cloud"),
});
export type CloudGrantClaims = z.infer<typeof CloudGrantClaims>;
/**
 * A publisher's grant for ace's marketplace (ADR 0168 §7, ADR 0174 §2), from a machine or a
 * device. The relay and ace cloud refuse it, and the market refuses theirs: each parser is strict
 * about its own. `iss` names the backend that minted it, `emailVerified` what WorkOS said of the
 * account's email, and `authAt` when the session behind it signed in, for actions that need a
 * recent sign-in.
 */
export const MarketGrantClaims = GrantClaims.extend({
  aud: z.literal("market.acehq.dev"),
  purpose: z.literal("market-publish"),
  iss: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-z0-9.-]+(?::\d{1,5})?$/),
  emailVerified: z.boolean(),
  authAt: z.number().int().nonnegative(),
});
export type MarketGrantClaims = z.infer<typeof MarketGrantClaims>;
/** The market grant's issuer, `cloud.acehq.dev`, unless a deployment configures its own. */
export const MARKET_GRANT_ISSUER = "cloud.acehq.dev";

/**
 * Who asked for a device grant (ADR 0190): `person`, a session the person signed in to in a
 * browser and that only the client they signed in on holds; `machine`, anything a machine keeps
 * (a daemon's machine credential, or a session that was ever written to a machine's disk).
 */
export const GrantStanding = z.enum(["person", "machine"]);
export type GrantStanding = z.infer<typeof GrantStanding>;
/**
 * A standing grant (ADR 0190): format 2, beside a device's format 1 grant. It says whose
 * session asked for the device grant, so a daemon can tell the person from a process that read a
 * machine's files. Format 1 parsers (older daemons, the relay) refuse it, and this parser refuses
 * format 1, so neither stands in for the other.
 */
export const StandingGrantClaims = z.strictObject({
  v: z.literal(2),
  kid: KeyId,
  kind: z.literal("device"),
  standing: GrantStanding,
  account: GrantClaims.shape.account,
  subject: GrantClaims.shape.subject,
  iat: GrantClaims.shape.iat,
  exp: GrantClaims.shape.exp,
});
export type StandingGrantClaims = z.infer<typeof StandingGrantClaims>;

export function signStandingGrant(
  claims: Omit<StandingGrantClaims, "v" | "kid" | "kind">,
  key: GrantSigningKey,
): string {
  return signClaims(
    StandingGrantClaims.parse({ ...claims, v: 2, kid: key.id, kind: "device" }),
    key,
  );
}

/** Verify a standing grant's signature and lifetime. Throws `GrantError` on any failure. */
export function verifyStandingGrant(
  token: string,
  keys: GrantKeySet,
  now: number,
): StandingGrantClaims {
  return verifySigned(token, keys, now, "device", StandingGrantClaims);
}

const AnyGrantClaims = z.union([
  GrantClaims,
  CloudGrantClaims,
  MarketGrantClaims,
  StandingGrantClaims,
]);

function signClaims(claims: object, key: GrantSigningKey): string {
  const body = new TextEncoder().encode(JSON.stringify(claims));
  return `${encodeBase64url(body)}.${encodeBase64url(ed25519.sign(body, key.privateKey))}`;
}

export function signMarketGrant(
  claims: Omit<GrantClaims, "v" | "kid"> &
    Pick<MarketGrantClaims, "iss" | "emailVerified" | "authAt">,
  key: GrantSigningKey,
): string {
  const full = MarketGrantClaims.parse({
    ...claims,
    v: 1,
    kid: key.id,
    aud: "market.acehq.dev",
    purpose: "market-publish",
  });
  const body = new TextEncoder().encode(JSON.stringify(full));
  return `${encodeBase64url(body)}.${encodeBase64url(ed25519.sign(body, key.privateKey))}`;
}

export function signCloudGrant(
  claims: Omit<GrantClaims, "v" | "kid">,
  key: GrantSigningKey,
): string {
  const full = CloudGrantClaims.parse({
    ...claims,
    v: 1,
    kid: key.id,
    aud: "cloud.acehq.dev",
    purpose: "spade-cloud",
  });
  const body = new TextEncoder().encode(JSON.stringify(full));
  return `${encodeBase64url(body)}.${encodeBase64url(ed25519.sign(body, key.privateKey))}`;
}

/** `GET /v1/keys` on the account backend. */
export const GrantKeySet = z.object({
  keys: z
    .array(z.object({ id: KeyId, publicKey: Base64url32 }))
    .min(1)
    .max(8),
});
export type GrantKeySet = z.infer<typeof GrantKeySet>;

export type GrantSigningKey = { id: string; privateKey: Uint8Array };

export class GrantError extends Error {
  override name = "GrantError";
}

export function encodeBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeBase64url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1)
    throw new GrantError("Invalid base64url");
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** The public half of a signing key, as published in the key set. */
export function grantPublicKey(key: GrantSigningKey): { id: string; publicKey: string } {
  return {
    id: KeyId.parse(key.id),
    publicKey: encodeBase64url(ed25519.getPublicKey(key.privateKey)),
  };
}

export function signGrant(claims: Omit<GrantClaims, "v" | "kid">, key: GrantSigningKey): string {
  const full = GrantClaims.parse({ ...claims, v: 1, kid: key.id });
  const body = new TextEncoder().encode(JSON.stringify(full));
  return `${encodeBase64url(body)}.${encodeBase64url(ed25519.sign(body, key.privateKey))}`;
}

/** Verify a grant's signature, kind and lifetime. Throws `GrantError` on any failure. */
export function verifyGrant(
  token: string,
  keys: GrantKeySet,
  now: number,
  kind: GrantKind,
): GrantClaims {
  return verifySigned(token, keys, now, kind, GrantClaims);
}

/**
 * Verify a cloud credential (ADR 0140, 0141): a `machine` grant that also names the cloud
 * audience and purpose. A general machine or device grant is refused, as `verifyGrant` refuses
 * a cloud credential.
 */
export function verifyCloudGrant(token: string, keys: GrantKeySet, now: number): CloudGrantClaims {
  return verifySigned(token, keys, now, "machine", CloudGrantClaims);
}

/**
 * Verify a market publishing grant, from a machine or a device: its signature, audience,
 * purpose, lifetime and issuer. Relay and cloud grants fail. The caller checks `emailVerified`
 * and `authAt`, which it answers in its own words.
 */
export function verifyMarketGrant(
  token: string,
  keys: GrantKeySet,
  now: number,
  issuer: string = MARKET_GRANT_ISSUER,
): MarketGrantClaims {
  const claims = verifySigned(token, keys, now, undefined, MarketGrantClaims);
  if (claims.iss !== issuer) throw new GrantError("Wrong grant issuer");
  return claims;
}

function verifySigned<Claims extends Pick<GrantClaims, "kid" | "kind" | "iat" | "exp">>(
  token: string,
  keys: GrantKeySet,
  now: number,
  kind: GrantKind | undefined,
  schema: z.ZodType<Claims>,
): Claims {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined || token.length > 2048)
    throw new GrantError("Malformed grant");
  const bytes = decodeBase64url(body);
  let claims: Claims;
  try {
    claims = schema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)),
    );
  } catch {
    throw new GrantError("Malformed grant");
  }
  const key = keys.keys.find((candidate) => candidate.id === claims.kid);
  if (!key) throw new GrantError("Unknown grant key");
  let valid = false;
  try {
    valid = ed25519.verify(decodeBase64url(signature), bytes, decodeBase64url(key.publicKey));
  } catch {
    valid = false;
  }
  if (!valid) throw new GrantError("Invalid grant signature");
  if (kind !== undefined && claims.kind !== kind) throw new GrantError("Wrong grant kind");
  if (claims.exp <= now) throw new GrantError("Grant expired");
  if (claims.iat > now + GRANT_SKEW_MS || claims.exp - claims.iat > GRANT_LIFETIME_MS)
    throw new GrantError("Grant lifetime invalid");
  return claims;
}

/**
 * How long a grant was issued for (`exp - iat`, both from the backend's clock), read without
 * checking its signature: a client uses it only to time its next refresh. Undefined if malformed.
 */
export function grantLifetimeMs(token: string): number | undefined {
  try {
    const body = token.split(".")[0] ?? "";
    const claims = AnyGrantClaims.parse(
      JSON.parse(new TextDecoder().decode(decodeBase64url(body))),
    );
    return claims.exp - claims.iat;
  } catch {
    return undefined;
  }
}

/**
 * How long before a market grant was issued its sign-in happened (`iat - authAt`), read without
 * checking the signature: the daemon reads it from a grant it just took from its own account
 * backend, to apply ADR 0174 §2's ten-minute rule before a person-only action. Both times are
 * the backend's, so this machine's clock doesn't enter into it. Undefined for any other grant or
 * a malformed one.
 */
export function grantSignInAge(token: string): number | undefined {
  try {
    const body = token.split(".")[0] ?? "";
    const claims = MarketGrantClaims.parse(
      JSON.parse(new TextDecoder().decode(decodeBase64url(body))),
    );
    return claims.iat - claims.authAt;
  } catch {
    return undefined;
  }
}

/** The grant a WebSocket upgrade offered in `Sec-WebSocket-Protocol`, if any. */
export function grantFromSubprotocols(header: string | null): string | undefined {
  for (const protocol of header?.split(",") ?? []) {
    const value = protocol.trim();
    if (value.startsWith(GRANT_SUBPROTOCOL_PREFIX))
      return value.slice(GRANT_SUBPROTOCOL_PREFIX.length);
  }
  return undefined;
}
