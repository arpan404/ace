import { expect, it } from "vitest";
import { grantPublicKey, signMemberGrant } from "@ace/account-grant";
import { MAX_LOOKUPS_IN_FLIGHT, orgStandingRoute } from "./org-standing-route.ts";
import { WorkosRefusal, type WorkosMembership } from "./workos-orgs.ts";

/*
 * The standing route's budget for WorkOS (ADR 0206 §6, amendment 3): a few lookups at once
 * however the checks interleave, and WorkOS's own rate limit taken as a refusal, never a yes.
 */

const key = { id: "k1", privateKey: new Uint8Array(32).fill(5) };
const NOW = 1_800_000_000_000;
const MARKET = "m".repeat(43);
const org = "org_01ACME";
const grant = signMemberGrant(
  {
    org,
    role: "member",
    account: "user_gus",
    subject: "phone",
    host: "A".repeat(52),
    key: "k".repeat(87),
    policy: 0,
    iat: NOW,
    exp: NOW + 60_000,
  },
  key,
);
const row = {
  org,
  membership: "om_1",
  role: "member",
  status: "active",
  directoryManaged: false,
  version: "2027-01-01T00:00:00.000Z",
  seq: 1,
};
const membership: WorkosMembership = {
  id: "om_1",
  user_id: "user_gus",
  organization_id: org,
  status: "active",
  role: { slug: "member" },
};

function route(findMembership: () => Promise<WorkosMembership | undefined>) {
  return orgStandingRoute({
    keys: { keys: [grantPublicKey(key)] },
    issuer: "cloud.example",
    orgs: { memberState: async () => row },
    workos: { findMembership },
    now: () => NOW,
    marketToken: MARKET,
    hostOrg: async () => undefined,
    addressLimited: async () => false,
    limited: async () => false,
    // The overall limit is a binding: answering it takes a turn of the event loop or more.
    workosLimited: () => new Promise((resolve) => setTimeout(() => resolve(false), 5)),
  });
}
const ask = (handle: ReturnType<typeof route>) =>
  handle(
    new Request("https://cloud.example/v1/grants/standing", {
      method: "POST",
      headers: { Authorization: `Bearer ${MARKET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ grant }),
    }),
  );

it("never has more WorkOS lookups waiting than its cap, however many checks arrive at once", async () => {
  let waiting = 0;
  let most = 0;
  const releases: (() => void)[] = [];
  const handle = route(async () => {
    waiting++;
    most = Math.max(most, waiting);
    await new Promise<void>((resolve) => releases.push(resolve));
    waiting--;
    return membership;
  });
  const answers = Array.from({ length: MAX_LOOKUPS_IN_FLIGHT + 2 }, () => ask(handle));
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const release of releases.splice(0)) release();
  const statuses = (await Promise.all(answers)).map((each) => each.status);
  expect(most).toBe(MAX_LOOKUPS_IN_FLIGHT);
  expect(statuses.filter((status) => status === 200)).toHaveLength(MAX_LOOKUPS_IN_FLIGHT);
  expect(statuses.filter((status) => status === 503)).toHaveLength(2);
});

it("takes WorkOS's rate limit as busy: no answer, and a time to come back", async () => {
  const answer = await ask(
    route(async () => {
      throw new WorkosRefusal(429, "rate_limit_exceeded");
    }),
  );
  expect(answer.status).toBe(503);
  expect(await answer.json()).toEqual({ error: "busy" });
  expect(answer.headers.get("Retry-After")).toBe("5");
});
