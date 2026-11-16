import { GrantKeySet } from "@ace/account-grant";

/*
 * The account backend's grant keys (ADR 0111), which a market publishing grant must verify
 * with. Read from configuration when set, otherwise fetched from the backend's `/v1/keys` and
 * kept for a few minutes. Clock and fetch are passed in.
 */

export const defaultKeysUrl = "https://cloud.acehq.dev/v1/keys";
export const keysTtlMs = 5 * 60_000;

export interface KeySource {
  /** The current keys, or undefined when none can be read. */
  get(): Promise<GrantKeySet | undefined>;
}

export function configuredKeys(text: string): KeySource {
  let parsed: GrantKeySet | undefined;
  try {
    parsed = GrantKeySet.safeParse(JSON.parse(text)).data;
  } catch {
    parsed = undefined;
  }
  return { get: async () => parsed };
}

export function fetchedKeys(options: {
  url: string;
  fetch: (url: string) => Promise<Response>;
  now: () => number;
  ttlMs?: number;
}): KeySource {
  const ttl = options.ttlMs ?? keysTtlMs;
  let cached: { keys: GrantKeySet; at: number } | undefined;
  return {
    async get() {
      if (cached && options.now() - cached.at < ttl) return cached.keys;
      try {
        const response = await options.fetch(options.url);
        if (response.ok) {
          const keys = GrantKeySet.safeParse(await response.json()).data;
          if (keys) {
            cached = { keys, at: options.now() };
            return keys;
          }
        }
      } catch {
        // Fall through: the last keys read stay in use while the backend can't be reached.
      }
      return cached?.keys;
    },
  };
}
