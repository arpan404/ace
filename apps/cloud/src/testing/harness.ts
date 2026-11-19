import { GRANT_LIFETIME_MS, signGrant } from "@ace/account-grant";
import type { GrantKind } from "@ace/account-grant";
import type { Env } from "../env.ts";
import { grantKey, launchWorker } from "./worker.ts";

export { allowedOrigin, grantKey, upgrade } from "./worker.ts";

/** Signs a grant as the account backend would, for relay tests that need no sign-in. */
export function mint(
  kind: GrantKind,
  account: string,
  subject: string,
  options: { iat?: number; key?: typeof grantKey } = {},
): string {
  const iat = options.iat ?? Date.now();
  return signGrant(
    { kind, account, subject, iat, exp: iat + GRANT_LIFETIME_MS },
    options.key ?? grantKey,
  );
}

/** The Worker under Miniflare with its bindings, for the Worker's own tests. */
export async function startWorker(options: Parameters<typeof launchWorker>[0] = {}) {
  const { harness, ...started } = await launchWorker(options);
  const worker = harness.getWorker<Env>();
  const env = await worker.getEnv();
  return {
    ...started,
    db: env.ACCOUNTS,
    env,
    /** A request to the Worker at any address, such as `https://cloud.acehq.dev/…`. */
    dispatch: (url: string, init?: Parameters<typeof worker.fetch>[1]) => worker.fetch(url, init),
    /**
     * Evicts the relay object for `hostId` as the runtime does when it hibernates: its memory
     * is dropped, its sockets stay connected with their attachments, and the next event
     * starts a fresh instance.
     */
    hibernate: (hostId: string) =>
      worker.evictDurableObject("RELAY", { name: hostId, webSockets: "hibernate" }),
  };
}
