/*
 * The token endpoint (OAuth 2.1 §3.2, ADR 0117): an authorization code with its PKCE verifier,
 * or a refresh token, for a token pair bound to the resource this base serves. Public clients
 * only, so the client is named by client_id and proven by PKCE or the refresh token it holds.
 * Replies are never cached, and no token or code is logged.
 */
import type { GrantStore } from "../grants.ts";
import type { GrantTokens, TokenPair } from "../tokens.ts";
import { namesResource, resourceOf, type OutsideBase } from "./base.ts";
import type { AuthorizationCodes } from "./codes.ts";

export interface TokenDeps {
  grants: Pick<GrantStore, "live">;
  tokens: Pick<GrantTokens, "issuePair" | "rotate">;
  codes: AuthorizationCodes;
  now: () => number;
}

const noStore = { "cache-control": "no-store", pragma: "no-cache" };

function error(status: number, code: string, description: string): Response {
  return Response.json(
    { error: code, error_description: description },
    { status, headers: noStore },
  );
}
function issued(pair: TokenPair, scopes: readonly string[], now: number): Response {
  return Response.json(
    {
      access_token: pair.accessToken,
      token_type: "Bearer",
      expires_in: Math.max(1, Math.floor((pair.accessExpiresAt - now) / 1000)),
      refresh_token: pair.refreshToken,
      scope: scopes.join(" "),
    },
    { headers: noStore },
  );
}

/** POST /token at `base`, with the form body already read. */
export function tokenRequest(form: URLSearchParams, base: OutsideBase, deps: TokenDeps): Response {
  const resource = resourceOf(base);
  const clientId = form.get("client_id");
  if (!clientId) return error(400, "invalid_request", "client_id is required.");
  const named = form.get("resource");
  if (named !== null && !namesResource(named, base))
    return error(400, "invalid_target", `resource must be ${resource}.`);
  switch (form.get("grant_type")) {
    case "authorization_code": {
      const code = form.get("code");
      const redirectUri = form.get("redirect_uri");
      const verifier = form.get("code_verifier");
      if (!code || !redirectUri || !verifier)
        return error(400, "invalid_request", "code, redirect_uri and code_verifier are required.");
      // RFC 8707 and MCP: the client names the resource when it trades the code, too.
      if (named === null) return error(400, "invalid_target", `resource must be ${resource}.`);
      const redeemed = deps.codes.redeem(code, { clientId, redirectUri, verifier, resource });
      if ("refused" in redeemed) return error(400, "invalid_grant", redeemed.refused);
      const grant = deps.grants.live(redeemed.grantId);
      if (!grant) return error(400, "invalid_grant", "The grant has ended.");
      return issued(deps.tokens.issuePair(grant, resource), grant.scopes, deps.now());
    }
    case "refresh_token": {
      const refreshToken = form.get("refresh_token");
      if (!refreshToken) return error(400, "invalid_request", "refresh_token is required.");
      const rotated = deps.tokens.rotate(refreshToken, { clientId, resource });
      if ("refused" in rotated) return error(400, "invalid_grant", refusals[rotated.refused]);
      const grant = deps.grants.live(rotated.grantId);
      if (!grant) return error(400, "invalid_grant", "The grant has ended.");
      return issued(rotated, grant.scopes, deps.now());
    }
    default:
      return error(
        400,
        "unsupported_grant_type",
        "Use grant_type authorization_code or refresh_token.",
      );
  }
}
const refusals = {
  unknown: "The refresh token is unknown.",
  expired: "The refresh token has expired.",
  reused: "The refresh token was already used; this grant is revoked. Sign in again.",
  mismatch: "The refresh token was issued to another client or resource.",
} as const;
