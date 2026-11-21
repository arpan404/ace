import { GrantError, MARKET_GRANT_ISSUER, verifyMarketGrant } from "@ace/account-grant";
import { registryProofHeader, registryRequestProved } from "@ace/marketplace/registry";
import type { Context } from "./context.ts";
import { bearer } from "./http.ts";
import { audienceOrg, currentKey } from "./store/registries.ts";

/*
 * Who may read an organization's registry (ADR 0206 §5.1): a market grant acting in that
 * organization, which the account backend mints only after WorkOS answered that the account is
 * an active member, or the registry's own signer, proved by its current key. Everyone else is
 * told the entry doesn't exist (404, never 403), so its existence doesn't leak.
 */

/** The organization a valid market grant on the request acts in, if any. */
export async function grantOrg(request: Request, context: Context): Promise<string | undefined> {
  const token = bearer(request);
  if (!token) return undefined;
  const keys = await context.grantKeys.get();
  if (!keys) return undefined;
  try {
    const issuer = context.env.ACE_GRANT_ISSUER ?? MARKET_GRANT_ISSUER;
    return verifyMarketGrant(token, keys, context.now, issuer).org;
  } catch (error) {
    if (error instanceof GrantError) return undefined;
    throw error;
  }
}

/** Whether the request was made by `org`'s signer, with the registry's current key. */
export async function registrySigner(
  request: Request,
  context: Context,
  org: string,
  body: Uint8Array = new Uint8Array(),
): Promise<boolean> {
  const header = request.headers.get(registryProofHeader);
  if (!header || !context.dbs.orgs) return false;
  const current = await currentKey(context.dbs.orgs, org);
  if (!current) return false;
  return registryRequestProved(header, current, {
    method: request.method,
    path: new URL(request.url).pathname,
    body,
    now: context.now,
  });
}

/** Whether the request may read what `audience` names. */
export async function mayRead(
  request: Request,
  context: Context,
  audience: string,
): Promise<boolean> {
  const org = audienceOrg(audience);
  if (org === undefined) return true;
  if ((await grantOrg(request, context)) === org) return true;
  return registrySigner(request, context, org);
}

/** A member's answer: never kept by a shared cache. */
export const privateHeaders = { "cache-control": "private, no-store" } as const;
