import { freshlyBelowLimit } from "@ace/accounts/availability";
import type { AccountQuota } from "@ace/protocol/accounts";

/**
 * Lets threads a usage limit held carry on as soon as their account has a fresh reading below
 * its limit (a Codex rate-limit read or update, a Claude window the provider allows again),
 * rather than waiting for a reset that may already have come early or for the person.
 */
export function recoverOnFreshReadings(options: {
  subscribeQuota(listener: (id: string) => void): () => void;
  quota(id: string): AccountQuota | undefined;
  recovered(id: string): void;
  now(): number;
  onError?(error: unknown): void;
}): () => void {
  return options.subscribeQuota((id) => {
    try {
      const quota = options.quota(id);
      if (quota && freshlyBelowLimit(quota, options.now())) options.recovered(id);
    } catch (error) {
      // A reading that can't be acted on now is acted on by the next one.
      options.onError?.(error);
    }
  });
}
