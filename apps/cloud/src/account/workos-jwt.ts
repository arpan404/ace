import { z } from "zod";
import { decodeBase64url } from "@ace/account-grant";

/**
 * Checks a WorkOS access token against WorkOS's JWKS for ace's client
 * (`GET /sso/jwks/{client_id}`) before ace believes its `org_id` and `role` (ADR 0206 §1.4). The
 * algorithm is read from the token's header and must match the key's: RS256 or ES256. Keys are
 * kept per isolate and fetched again for a key id they don't hold, at most once a minute.
 */

const Jwk = z.looseObject({
  kty: z.string(),
  kid: z.string().max(256),
  alg: z.string().optional(),
  n: z.string().optional(),
  e: z.string().optional(),
  crv: z.string().optional(),
  x: z.string().optional(),
  y: z.string().optional(),
});
const Jwks = z.object({ keys: z.array(z.unknown()).max(32) });
const Header = z.object({ alg: z.string(), kid: z.string().max(256) });
const Claims = z.looseObject({
  sub: z.string().min(1).max(256),
  sid: z.string().min(1).max(256),
  org_id: z.string().max(128).optional(),
  role: z.string().max(64).optional(),
  permissions: z.array(z.string().max(128)).max(256).optional(),
  exp: z.number(),
});

/** What a verified access token says of the session's place in an organization. */
export type OrgToken = { account: string; sid: string; org: string; role: string };

export class TokenError extends Error {
  override name = "TokenError";
}

const KEY_TTL_MS = 10 * 60_000;
const REFETCH_MS = 60_000;
/** Clock skew allowed on the token's `exp`. */
const SKEW_MS = 30_000;

const algorithms = {
  RS256: {
    kty: "RSA",
    import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    verify: { name: "RSASSA-PKCS1-v1_5" },
  },
  ES256: {
    kty: "EC",
    import: { name: "ECDSA", namedCurve: "P-256" },
    verify: { name: "ECDSA", hash: "SHA-256" },
  },
} as const;
type Algorithm = keyof typeof algorithms;
const isAlgorithm = (alg: string): alg is Algorithm => alg === "RS256" || alg === "ES256";

function decodeJson(part: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(decodeBase64url(part)));
  } catch {
    throw new TokenError("Malformed token");
  }
}

export function workosTokenVerifier(deps: {
  jwksUrl: string;
  fetch: typeof fetch;
  now: () => number;
}) {
  let cached: { at: number; keys: Map<string, z.infer<typeof Jwk>> } | undefined;
  let lastFetch = Number.NEGATIVE_INFINITY;

  async function load(): Promise<Map<string, z.infer<typeof Jwk>>> {
    lastFetch = deps.now();
    const response = await deps.fetch(deps.jwksUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`WorkOS JWKS answered ${response.status}`);
    const parsed = Jwks.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new Error("WorkOS JWKS has an unexpected shape");
    const keys = new Map<string, z.infer<typeof Jwk>>();
    // A key of a kind ace can't use is skipped, not fatal.
    for (const raw of parsed.data.keys) {
      const key = Jwk.safeParse(raw);
      if (key.success) keys.set(key.data.kid, key.data);
    }
    cached = { at: deps.now(), keys };
    return keys;
  }

  async function keyFor(kid: string) {
    const fresh = cached && deps.now() - cached.at < KEY_TTL_MS ? cached.keys : await load();
    const found = fresh.get(kid);
    if (found || deps.now() - lastFetch < REFETCH_MS) return found;
    return (await load()).get(kid);
  }

  return {
    /**
     * The token's account, session id, organization and role, once its signature verified with
     * WorkOS's key and it hasn't expired. Throws `TokenError` when it can't be believed.
     */
    async verify(token: string): Promise<OrgToken> {
      const [head, body, signature, extra] = token.split(".");
      if (!head || !body || !signature || extra !== undefined || token.length > 16_384)
        throw new TokenError("Malformed token");
      const header = Header.safeParse(decodeJson(head));
      if (!header.success || !isAlgorithm(header.data.alg))
        throw new TokenError("Unsupported token");
      const algorithm = algorithms[header.data.alg];
      const jwk = await keyFor(header.data.kid);
      if (!jwk || jwk.kty !== algorithm.kty || (jwk.alg && jwk.alg !== header.data.alg))
        throw new TokenError("Unknown token key");
      let valid = false;
      try {
        const material: JsonWebKey = { kty: jwk.kty };
        for (const field of ["n", "e", "crv", "x", "y"] as const) {
          const value = jwk[field];
          if (value !== undefined) material[field] = value;
        }
        const key = await crypto.subtle.importKey("jwk", material, algorithm.import, false, [
          "verify",
        ]);
        valid = await crypto.subtle.verify(
          algorithm.verify,
          key,
          decodeBase64url(signature),
          new TextEncoder().encode(`${head}.${body}`),
        );
      } catch {
        valid = false;
      }
      if (!valid) throw new TokenError("Invalid token signature");
      const claims = Claims.safeParse(decodeJson(body));
      if (!claims.success) throw new TokenError("Malformed token");
      if (claims.data.exp * 1000 + SKEW_MS <= deps.now()) throw new TokenError("Token expired");
      if (!claims.data.org_id) throw new TokenError("Token names no organization");
      return {
        account: claims.data.sub,
        sid: claims.data.sid,
        org: claims.data.org_id,
        // A membership with no role reads as WorkOS's default.
        role: claims.data.role ?? "member",
      };
    },
  };
}
export type WorkosTokenVerifier = ReturnType<typeof workosTokenVerifier>;
