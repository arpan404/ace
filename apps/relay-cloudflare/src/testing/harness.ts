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
export async function startWorker(
  options: { accounts?: boolean; workosUrl?: string; previousGrantKey?: string } = {},
) {
  const { harness, ...started } = await launchWorker(options);
  const env = await harness.getWorker<Env>().getEnv();
  return { ...started, db: env.ACCOUNTS };
}
