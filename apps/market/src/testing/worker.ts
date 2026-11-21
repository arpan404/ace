import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { GRANT_LIFETIME_MS, grantPublicKey, signMarketGrant } from "@ace/account-grant";
import type { MarketSigningKey } from "@ace/marketplace";
import { keySetOf, testKey } from "@ace/marketplace/testing";
import { catalogueBindingNames, domainBindingNames } from "../store/binding-names.ts";

// Kept free of Worker sources (and so of Cloudflare's global types): other workspaces' tests
// import this through `@ace/market/testing`.

/** The grant signing key the test Worker trusts unless told otherwise. */
export const grantKey = { id: "acct", privateKey: new Uint8Array(32).fill(3) };
/** The market's signing key in tests: the Worker's public keys hold its public half. */
export const marketKey: MarketSigningKey = testKey("market", 9);
export const signerToken = "signer-token-for-tests";

/** A grant key the Worker trusts, as the account backend publishes it. */
export type GrantKey = ReturnType<typeof grantPublicKey>;

/** A market publishing grant for `account`, signed with the test key, as the backend mints it. */
export function marketGrant(account: string): string {
  const iat = Date.now();
  return signMarketGrant(
    {
      kind: "machine",
      account,
      subject: "host-a",
      iss: "cloud.acehq.dev",
      emailVerified: true,
      authAt: iat,
      iat,
      exp: iat + GRANT_LIFETIME_MS,
    },
    grantKey,
  );
}

/**
 * The market Worker under real workerd (Miniflare), with every local D1 database migrated, each
 * from its own migration folder (ADR 0174 §16). It trusts grants by the test key and by
 * `grantKeys` (an account backend's).
 */
export async function launchMarketWorker(options: { grantKeys?: readonly GrantKey[] } = {}) {
  const harness = createTestHarness({
    workers: [
      {
        configPath: fileURLToPath(import.meta.resolve("../../wrangler.jsonc")),
        secrets: {
          ACE_GRANT_KEYS: JSON.stringify({
            keys: [grantPublicKey(grantKey), ...(options.grantKeys ?? [])],
          }),
          MARKET_PUBLIC_KEYS: JSON.stringify(keySetOf(marketKey)),
          MARKET_SIGNER_TOKEN: signerToken,
        },
      },
    ],
  });
  const { url } = await harness.listen();
  for (const binding of [
    ...Object.values(catalogueBindingNames),
    ...Object.values(domainBindingNames),
  ])
    await harness.getWorker().applyD1Migrations(binding);
  return { harness, url };
}

/** Where a test reaches the Worker by path: its own fetch, as market.acehq.dev. */
export const marketAddress = (path: string) => `https://market.acehq.dev${path}`;
