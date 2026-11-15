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
  /** When the last fetch started, whatever its outcome: the cooldown counts attempts. */
  let attemptedAt = Number.NEGATIVE_INFINITY;
  const tried = new Set<string>();
  const refresh = () => {
    if (!fetching) attemptedAt = options.now();
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
        options.now() - Math.max(fetchedAt, attemptedAt) < KEY_REFETCH_MS
      )
        return keys;
      if (tried.size >= rememberedUnknown) tried.clear();
      tried.add(kid);
      return refresh();
    },
    /**
     * The keys to verify `token` with, only if already cached, for a check that may not wait on
     * the network (an NK first message, ADR 0155). A miss starts the same fetch `forGrant` would,
     * in the background, for the client's next attempt.
     */
    cached(token: string): GrantKeySet | undefined {
      const kid = grantKeyId(token);
      if (keys && (kid === undefined || keys.keys.some((key) => key.id === kid))) return keys;
      // One fetch at a time, and at most one attempt a minute whether the last one failed or
      // not: an unauthenticated sender's misses can't make the daemon call out any faster.
      if (!fetching && options.now() - attemptedAt >= KEY_REFETCH_MS)
        void refresh().catch(() => {});
      return undefined;
    },
    /** Forget the keys, for another account origin. */
    reset() {
      keys = undefined;
      fetchedAt = Number.NEGATIVE_INFINITY;
      tried.clear();
    },
  };
}
