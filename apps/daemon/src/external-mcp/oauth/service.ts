/*
 * Puts the OAuth pieces together over one OutsideAccess (ADR 0117): metadata documents and DCR
 * registrations resolve clients, codes and the token endpoint issue pairs, and the surface
 * serves it all at whichever base a request arrived at.
 */
import type { GrantSql } from "../grants.ts";
import type { OutsideAccess } from "../outside.ts";
import type { RandomBytes } from "../tokens.ts";
import { Authorizations } from "./authorize.ts";
import { ClientMetadata, metadataUrl, type MetadataFetch } from "./cimd.ts";
import { AuthorizationCodes } from "./codes.ts";
import { ClientRegistrations } from "./registrations.ts";
import { outsideSurface } from "./surface.ts";

export function outsideOAuth(deps: {
  outside: OutsideAccess;
  sql: GrantSql;
  now: () => number;
  random: RandomBytes;
  after: (ms: number, run: () => void) => () => void;
  fetchMetadata: MetadataFetch;
  machine(): string;
  note?: (text: string) => void;
}) {
  const { outside, now, random } = deps;
  const documents = new ClientMetadata({ fetch: deps.fetchMetadata, now });
  const registrations = new ClientRegistrations({ sql: deps.sql, now, random });
  const codes = new AuthorizationCodes({ now, random });
  const authorizations = new Authorizations({
    outside,
    clients: {
      resolve: async (clientId) =>
        metadataUrl(clientId)
          ? documents.resolve(clientId)
          : (registrations.get(clientId) ?? {
              problem: "This client isn't registered here. Start the sign-in again from its app.",
            }),
      approved: (client) => {
        if (client.kind === "dcr") registrations.markUsed(client.clientId);
      },
    },
    codes,
    random,
    now,
    after: deps.after,
    machine: deps.machine,
    ...(deps.note ? { note: deps.note } : {}),
  });
  return outsideSurface({
    authorizations,
    registrations,
    token: {
      grants: outside.grants,
      tokens: outside.tokens,
      codes,
      now,
      revoke(grantId) {
        if (outside.revoke(grantId))
          deps.note?.(`Outside grant ${grantId} revoked: its authorization code was used twice.`);
      },
    },
    machine: deps.machine,
    now,
  });
}
