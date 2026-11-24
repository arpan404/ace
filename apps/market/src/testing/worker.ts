import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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

/** The claims an org grant carries, read without its signature: the fake trusts the market. */
function grantClaims(token: string): { account?: string; orgRole?: string } {
  try {
    const body = JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8"));
    return typeof body === "object" && body !== null ? body : {};
  } catch {
    return {};
  }
}

/**
 * A stand-in for the account backend's `POST /v1/grants/standing` (ADR 0206 §6): every org
 * grant is current, with the role it carries, until a test says its member left (`end`), has
 * another role now (`setRole`), or the backend can't be reached (`down`).
 */
/** The token the test Worker asks the standing route with, as the backend's would expect. */
export const standingToken = "market_standing_token_for_tests_0123456789a";

export async function fakeOrgStanding() {
  const ended = new Set<string>();
  const roles = new Map<string, string>();
  let down = false;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      // The backend answers only the market's own token.
      if (down || request.headers.authorization !== `Bearer ${standingToken}`) {
        response.writeHead(down ? 503 : 401).end();
        return;
      }
      let grant = "";
      try {
        grant = String(JSON.parse(Buffer.concat(chunks).toString("utf8")).grant ?? "");
      } catch {
        grant = "";
      }
      const claims = grantClaims(grant);
      const account = claims.account ?? "";
      const role = roles.get(account) ?? claims.orgRole ?? "";
      const current = !ended.has(account) && role === claims.orgRole;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(current ? { current, role } : { current: false }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1/grants/standing`,
    /** The member left the organization: no grant of theirs is current. */
    end: (account: string) => ended.add(account),
    /** The member's role is `role` now: a grant carrying another is no longer current. */
    setRole: (account: string, role: string) => roles.set(account, role),
    /** While on, the backend answers 503. */
    down: (on: boolean) => {
      down = on;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
export type FakeOrgStanding = Awaited<ReturnType<typeof fakeOrgStanding>>;

/**
 * The market Worker under real workerd (Miniflare), with every local D1 database migrated, each
 * from its own migration folder (ADR 0174 §16). It trusts grants by the test key and by
 * `grantKeys` (an account backend's), and asks `standing` whether an org grant is still current.
 */
export async function launchMarketWorker(
  options: {
    grantKeys?: readonly GrantKey[];
    standing?: { url: string };
    reviewKeys?: string;
  } = {},
) {
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
          ...(options.reviewKeys && { SPADE_REVIEW_PUBLIC_KEYS: options.reviewKeys }),
          ...(options.standing
            ? { ACE_ORG_STANDING_URL: options.standing.url, ACE_ORG_STANDING_TOKEN: standingToken }
            : {}),
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
