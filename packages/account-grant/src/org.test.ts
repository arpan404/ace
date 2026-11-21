import { expect, it } from "vitest";
import {
  GRANT_LIFETIME_MS,
  grantLifetimeMs,
  grantPublicKey,
  policyBodySha256,
  signGrant,
  signMarketGrant,
  signMemberGrant,
  signOrgPolicy,
  signStandingGrant,
  verifyGrant,
  verifyMarketGrant,
  verifyMemberGrant,
  verifyOrgPolicy,
  verifyStandingGrant,
} from "./index.ts";
import type { GrantKeySet } from "./index.ts";
import { orgAllows, orgRole } from "./org-roles.ts";

const key = { id: "k1", privateKey: new Uint8Array(32).fill(9) };
const other = { id: "k2", privateKey: new Uint8Array(32).fill(8) };
const keys = { keys: [grantPublicKey(key)] };
const member = {
  org: "org_01ACME",
  role: "admin",
  account: "user_1",
  subject: "phone",
  host: "H".repeat(52),
  key: "k".repeat(87),
  policy: 2,
  iat: 1_000,
  exp: 1_000 + GRANT_LIFETIME_MS,
};

it("a member grant names its organization, role, host, device key and policy, and expires", () => {
  const token = signMemberGrant(member, key);
  expect(verifyMemberGrant(token, keys, 2_000)).toMatchObject({
    v: 3,
    kind: "member",
    aud: "ace-daemon",
    standing: "member",
    org: "org_01ACME",
    role: "admin",
    host: member.host,
    key: member.key,
    policy: 2,
  });
  expect(grantLifetimeMs(token)).toBe(GRANT_LIFETIME_MS);
  expect(() => verifyMemberGrant(token, keys, member.exp)).toThrow("expired");
  expect(() => verifyMemberGrant(signMemberGrant(member, other), keys, 2_000)).toThrow("Unknown");
});

it("format 1 and 2 parsers refuse a member grant, and the member parser refuses theirs", () => {
  const token = signMemberGrant(member, key);
  for (const kind of ["machine", "device"] as const)
    expect(() => verifyGrant(token, keys, 2_000, kind)).toThrow("Malformed");
  expect(() => verifyStandingGrant(token, keys, 2_000)).toThrow("Malformed");
  expect(() => verifyMarketGrant(token, keys, 2_000)).toThrow("Malformed");
  const { org: _org, role: _role, policy: _policy, ...rest } = member;
  const person = signStandingGrant({ ...rest, standing: "person" }, key);
  expect(() => verifyMemberGrant(person, keys, 2_000)).toThrow("Malformed");
  const formatOne = signGrant(
    { kind: "device", account: "user_1", subject: "phone", iat: 1_000, exp: member.exp },
    key,
  );
  expect(() => verifyMemberGrant(formatOne, keys, 2_000)).toThrow("Malformed");
});

it("a member grant always names one host and one device key", () => {
  const { host: _host, ...noHost } = member;
  const { key: _key, ...noKey } = member;
  expect(() => signMemberGrant(noHost as typeof member, key)).toThrow();
  expect(() => signMemberGrant(noKey as typeof member, key)).toThrow();
  expect(() => signMemberGrant({ ...member, org: "acme" }, key)).toThrow();
});

it("the shared member grant vectors give the same verdicts here", async () => {
  const { readFile } = await import("node:fs/promises");
  const { member: vectors } = JSON.parse(
    await readFile(new URL("../test-vectors.json", import.meta.url), "utf8"),
  ) as {
    member: {
      keys: GrantKeySet;
      now: number;
      valid: { token: string; org: string; role: string; account: string; policy: number }[];
      invalid: { why: string; token: string; now?: number }[];
    };
  };
  expect(vectors.valid.length).toBeGreaterThan(0);
  for (const each of vectors.valid) {
    expect(verifyMemberGrant(each.token, vectors.keys, vectors.now)).toMatchObject({
      org: each.org,
      role: each.role,
      account: each.account,
      policy: each.policy,
    });
    // An older daemon reading the same token never takes it as the person.
    expect(() => verifyStandingGrant(each.token, vectors.keys, vectors.now)).toThrow();
  }
  expect(vectors.invalid.length).toBeGreaterThan(0);
  for (const each of vectors.invalid)
    expect(
      () => verifyMemberGrant(each.token, vectors.keys, each.now ?? vectors.now),
      each.why,
    ).toThrow();
});

it("a policy statement verifies only with the body it was made over and a published key", () => {
  const body = JSON.stringify({ effects: { pay: "off" } });
  const statement = signOrgPolicy(
    {
      org: "org_01ACME",
      version: 3,
      body_sha256: policyBodySha256(body),
      set_by: "user_1",
      set_at: 5,
    },
    key,
  );
  expect(verifyOrgPolicy(statement, keys, body)).toMatchObject({ version: 3, org: "org_01ACME" });
  expect(() => verifyOrgPolicy(statement, keys, `${body} `)).toThrow("match");
  expect(() => verifyOrgPolicy(statement, { keys: [grantPublicKey(other)] }, body)).toThrow(
    "Unknown",
  );
  // No grant parser takes a policy statement, and the policy parser takes no grant.
  expect(() => verifyGrant(statement, keys, 6, "device")).toThrow("Malformed");
  expect(() => verifyMemberGrant(statement, keys, 6)).toThrow("Malformed");
  expect(() => verifyOrgPolicy(signMemberGrant(member, key), keys, body)).toThrow("Malformed");
});

it("a market grant may carry the organization it acts in", () => {
  const market = signMarketGrant(
    {
      kind: "device",
      account: "user_1",
      subject: "phone",
      iat: 1_000,
      exp: 1_000 + GRANT_LIFETIME_MS,
      iss: "cloud.acehq.dev",
      emailVerified: true,
      authAt: 900,
      org: "org_01ACME",
    },
    key,
  );
  expect(verifyMarketGrant(market, keys, 2_000).org).toBe("org_01ACME");
});

it("ace authorizes a role from its own table, and an unknown role acts as a member", () => {
  expect(orgAllows("owner", "host:shell")).toBe(true);
  expect(orgAllows("owner", "members:manage")).toBe(true);
  expect(orgAllows("admin", "host:shell")).toBe(false);
  expect(orgAllows("admin", "members:manage")).toBe(true);
  expect(orgAllows("member", "members:manage")).toBe(false);
  expect(orgAllows("member", "bots:use")).toBe(true);
  expect(orgRole("org_custom_reviewer")).toBe("member");
  expect(orgAllows("org_custom_reviewer", "policy:set")).toBe(false);
  expect(orgAllows("billing", "bots:use")).toBe(false);
});
