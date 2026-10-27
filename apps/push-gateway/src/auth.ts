import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";

const Header = z.object({ alg: z.literal("ES256") });
const Claims = z.object({
  aud: z.string().max(2048),
  exp: z.number().int().nonnegative(),
});
const maxLifetimeSeconds = 24 * 60 * 60;

/**
 * Verifies RFC 8292 VAPID authorization, `vapid t=<jwt>, k=<P-256 point>`, for this gateway's
 * origin. Returns the daemon's identity, the base64url SHA-256 of its public key, or undefined.
 * Pure apart from the crypto calls; the clock is passed in.
 */
export function daemonIdentity(
  authorization: string | undefined,
  audience: string,
  nowMs: number,
): string | undefined {
  if (!authorization || authorization.length > 2048) return undefined;
  const match =
    /^vapid t=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+), ?k=([A-Za-z0-9_-]{87})$/.exec(
      authorization.trim(),
    );
  if (!match) return undefined;
  const [, token = "", key = ""] = match;
  const point = Buffer.from(key, "base64url");
  if (point.length !== 65 || point[0] !== 4) return undefined;
  const [header = "", claims = "", signature = ""] = token.split(".");
  try {
    if (!Header.safeParse(json(header)).success) return undefined;
    const parsed = Claims.safeParse(json(claims));
    if (!parsed.success || parsed.data.aud !== audience) return undefined;
    const now = Math.floor(nowMs / 1000);
    if (parsed.data.exp <= now || parsed.data.exp > now + maxLifetimeSeconds) return undefined;
    const publicKey = createPublicKey({
      format: "jwk",
      key: {
        kty: "EC",
        crv: "P-256",
        x: point.subarray(1, 33).toString("base64url"),
        y: point.subarray(33).toString("base64url"),
      },
    });
    const valid = verify(
      "sha256",
      Buffer.from(`${header}.${claims}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    );
    return valid ? createHash("sha256").update(point).digest("base64url") : undefined;
  } catch {
    return undefined;
  }
}
function json(part: string): unknown {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}
