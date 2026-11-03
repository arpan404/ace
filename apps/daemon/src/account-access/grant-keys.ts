import { GrantClaims, decodeBase64url, type GrantKeySet } from "@ace/account-grant";
import { z } from "zod";

/** How often an unknown key id may trigger a key refetch, whatever the id. */
export const KEY_REFETCH_MS = 60_000;
const rememberedUnknown = 256;
/** Only the key id, from claims that are not yet verified. */
const NamedKey = z.object({ kid: GrantClaims.shape.kid });

/** The key id a grant names, read without trusting it; undefined when it names none. */
export function grantKeyId(token: string): string | undefined {
  const body = token.split(".")[0];
  if (!body || token.length > 2048) return undefined;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(decodeBase64url(body)));
    return NamedKey.safeParse(parsed).data?.kid;
  } catch {
    return undefined;
  }
}

/**
 * The account backend's published grant keys, cached. A grant naming a key id the cache lacks
 * refetches once for that id (and at most once a minute overall); unknown ids after that are
 * refused by verification. Fetch and clock are injected.
 */
export function grantKeyCache(options: {
  fetchKeys: () => Promise<GrantKeySet>;
  now: () => number;
}) {
  let keys: GrantKeySet | undefined;
  let fetching: Promise<GrantKeySet> | undefined;
  let fetchedAt = Number.NEGATIVE_INFINITY;
  const tried = new Set<string>();
  const refresh = () => {
    fetching ??= options
      .fetchKeys()
      .then((fresh) => {
        keys = fresh;
        fetchedAt = options.now();
        return fresh;
      })
      .finally(() => {
        fetching = undefined;
      });
    return fetching;
  };
  return {
    /** The keys to verify `token` with, refetched when it names a new key id. */
    async forGrant(token: string): Promise<GrantKeySet> {
      if (!keys) return refresh();
      const kid = grantKeyId(token);
      if (
        kid === undefined ||
        keys.keys.some((key) => key.id === kid) ||
        tried.has(kid) ||
        options.now() - fetchedAt < KEY_REFETCH_MS
      )
        return keys;
      if (tried.size >= rememberedUnknown) tried.clear();
      tried.add(kid);
      return refresh();
    },
    /** Forget the keys, for another account origin. */
    reset() {
      keys = undefined;
      fetchedAt = Number.NEGATIVE_INFINITY;
      tried.clear();
    },
  };
}
