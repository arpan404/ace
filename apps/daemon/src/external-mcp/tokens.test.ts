import { expect, test } from "vitest";
import { accessTokenTtlMs, refreshGraceMs, spentRefreshKeptMs } from "./tokens.ts";
import { draft, grantFixture } from "./grant-test-support.ts";

/** The MCP URL the pairs are issued for, and the client the draft grant belongs to. */
const resource = "https://relay.example/m/host-1/mcp";
const at = { resource, clientId: draft().clientId };

test("an access token works for an hour and no longer", () => {
  const f = grantFixture();
  const grant = f.grants.create(draft());
  const pair = f.tokens.issuePair(grant, resource);
  expect(f.tokens.verify(pair.accessToken, resource)?.id).toBe(grant.id);
  f.clock.now += accessTokenTtlMs - 1;
  expect(f.tokens.verify(pair.accessToken, resource)?.id).toBe(grant.id);
  f.clock.now += 1;
  expect(f.tokens.verify(pair.accessToken, resource)).toBeUndefined();
});

test("no token outlives its grant's expiry", () => {
  const f = grantFixture();
  const grant = f.grants.create(draft({ expiresAt: f.clock.now + 10 * 60_000 }));
  const pair = f.tokens.issuePair(grant, resource);
  const bearer = f.tokens.issueBearer(grant);
  expect(pair.accessExpiresAt).toBe(grant.expiresAt);
  f.clock.now += 10 * 60_000;
  expect(f.tokens.verify(pair.accessToken, resource)).toBeUndefined();
  expect(f.tokens.verify(bearer)).toBeUndefined();
  expect(f.tokens.rotate(pair.refreshToken, at)).toEqual({ refused: "expired" });
});

test("a pasted CLI token lasts as long as its grant, even past an hour", () => {
  const f = grantFixture();
  const grant = f.grants.create(draft({ clientKind: "cli", expiresAt: f.clock.now + 86_400_000 }));
  const bearer = f.tokens.issueBearer(grant);
  f.clock.now += 86_400_000 - 1;
  expect(f.tokens.verify(bearer)?.id).toBe(grant.id);
});

test("a refresh token trades once for a new pair and then stops working", () => {
  const f = grantFixture();
  const grant = f.grants.create(draft());
  const first = f.tokens.issuePair(grant, resource);
  const second = f.tokens.rotate(first.refreshToken, at);
  if ("refused" in second) throw new Error(`refused: ${second.refused}`);
  expect(second.refreshToken).not.toBe(first.refreshToken);
  expect(f.tokens.verify(second.accessToken, resource)?.id).toBe(grant.id);
  // A refresh token is never accepted as a bearer.
  expect(f.tokens.verify(second.refreshToken, resource)).toBeUndefined();
  const third = f.tokens.rotate(second.refreshToken, at);
  expect("accessToken" in third).toBe(true);
});

test("presenting a refresh token traded more than a minute ago revokes the whole grant", () => {
  const f = grantFixture();
  const grant = f.grants.create(draft());
  const first = f.tokens.issuePair(grant, resource);
  const second = f.tokens.rotate(first.refreshToken, at);
  if ("refused" in second) throw new Error("first rotation refused");
  f.clock.now += refreshGraceMs + 1;
  expect(f.tokens.rotate(first.refreshToken, at)).toEqual({ refused: "reused" });
  expect(f.revoked).toEqual([grant.id]);
  expect(f.grants.get(grant.id)?.revokedAt).toBe(f.clock.now);
  // The legitimate holder's newer tokens die with the grant.
  expect(f.tokens.verify(second.accessToken, resource)).toBeUndefined();
  expect(f.tokens.rotate(second.refreshToken, at)).toMatchObject({ refused: expect.any(String) });
});

test("revoking a grant ends its tokens on the next check and keeps the grant's row", () => {
  const f = grantFixture();
  const grant = f.grants.create(draft());
  const bearer = f.tokens.issueBearer(grant);
  expect(f.grants.revoke(grant.id)).toBe(true);
  expect(f.tokens.verify(bearer)).toBeUndefined();
  expect(f.grants.get(grant.id)).toMatchObject({
    name: "Example assistant",
    revokedAt: f.clock.now,
  });
  expect(f.grants.revoke(grant.id)).toBe(false);
});

test("grants and tokens read back from the database after a restart", () => {
  const f = grantFixture();
  const grant = f.grants.create(draft({ scopes: ["browser"] }));
  const pair = f.tokens.issuePair(grant, resource);
  const reopened = f.open();
  expect(reopened.tokens.verify(pair.accessToken, resource)).toMatchObject({
    id: grant.id,
    scopes: ["threads:read", "browser"],
  });
  expect("accessToken" in reopened.tokens.rotate(pair.refreshToken, at)).toBe(true);
});

test("tokens are stored only as hashes", () => {
  const f = grantFixture();
  const grant = f.grants.create(draft());
  const pair = f.tokens.issuePair(grant, resource);
  const bearer = f.tokens.issueBearer(grant);
  const stored = JSON.stringify(f.db.prepare("SELECT * FROM outside_grant_tokens").all());
  for (const token of [pair.accessToken, pair.refreshToken, bearer])
    expect(stored).not.toContain(token);
});

test("malformed and unknown tokens authenticate nobody", () => {
  const f = grantFixture();
  f.tokens.issueBearer(f.grants.create(draft()));
  for (const token of ["", "x", "a".repeat(43), "' OR 1=1 --"])
    expect(f.tokens.verify(token)).toBeUndefined();
  expect(f.tokens.rotate("a".repeat(43), at)).toEqual({ refused: "unknown" });
});

test("a client that lost its /token reply may trade the same refresh token again within a minute", () => {
  const f = grantFixture();
  const grant = f.grants.create(draft());
  const first = f.tokens.issuePair(grant, resource);
  const lost = f.tokens.rotate(first.refreshToken, at);
  if ("refused" in lost) throw new Error("first rotation refused");
  f.clock.now += refreshGraceMs;
  const retried = f.tokens.rotate(first.refreshToken, at);
  if ("refused" in retried) throw new Error(`retry refused: ${retried.refused}`);
  expect(f.revoked).toEqual([]);
  expect(f.tokens.verify(retried.accessToken, resource)?.id).toBe(grant.id);
  // The pair whose reply never arrived stops working, without costing the grant.
  expect(f.tokens.verify(lost.accessToken, resource)).toBeUndefined();
  expect(f.tokens.rotate(lost.refreshToken, at)).toEqual({ refused: "unknown" });
  expect(f.grants.live(grant.id)).toBeDefined();
  expect("accessToken" in f.tokens.rotate(retried.refreshToken, at)).toBe(true);
});

test("a refresh token traded twice since is reuse, even within the minute", () => {
  const f = grantFixture();
  const grant = f.grants.create(draft());
  const first = f.tokens.issuePair(grant, resource);
  const second = f.tokens.rotate(first.refreshToken, at);
  if ("refused" in second) throw new Error("refused");
  expect("accessToken" in f.tokens.rotate(second.refreshToken, at)).toBe(true);
  expect(f.tokens.rotate(first.refreshToken, at)).toEqual({ refused: "reused" });
  expect(f.revoked).toEqual([grant.id]);
});

test("extending a CLI grant extends its pasted token", () => {
  const f = grantFixture();
  const grant = f.grants.create(draft({ clientKind: "cli", expiresAt: f.clock.now + 60_000 }));
  const bearer = f.tokens.issueBearer(grant);
  f.grants.update(grant.id, { expiresAt: f.clock.now + 86_400_000 });
  f.clock.now += 120_000;
  expect(f.tokens.verify(bearer)?.id).toBe(grant.id);
});

test("traded refresh tokens of a grant without expiry are dropped after their keeping time", () => {
  const f = grantFixture();
  const grant = f.grants.create(draft({ expiresAt: null }));
  const first = f.tokens.issuePair(grant, resource);
  const second = f.tokens.rotate(first.refreshToken, at);
  if ("refused" in second) throw new Error("refused");
  const spent = () =>
    f.db
      .prepare("SELECT COUNT(*) AS n FROM outside_grant_tokens WHERE rotated_at IS NOT NULL")
      .get()?.["n"];
  expect(spent()).toBe(1);
  f.clock.now += spentRefreshKeptMs;
  expect("accessToken" in f.tokens.rotate(second.refreshToken, at)).toBe(true);
  // The first is gone; the one just traded is kept.
  expect(spent()).toBe(1);
  expect(f.tokens.rotate(first.refreshToken, at)).toEqual({ refused: "unknown" });
  expect(f.grants.live(grant.id)).toBeDefined();
});

test("an OAuth token works only at the resource it was issued for", () => {
  const f = grantFixture();
  const grant = f.grants.create(draft());
  const pair = f.tokens.issuePair(grant, resource);
  expect(f.tokens.verify(pair.accessToken, resource)?.id).toBe(grant.id);
  for (const elsewhere of [
    "https://relay.example/m/host-2/mcp",
    "http://127.0.0.1:4000/mcp",
    undefined,
  ])
    expect(f.tokens.verify(pair.accessToken, elsewhere)).toBeUndefined();
});

test("a pasted token works at the loopback endpoint only", () => {
  const f = grantFixture();
  const bearer = f.tokens.issueBearer(f.grants.create(draft({ clientKind: "cli" })));
  expect(f.tokens.verify(bearer, "http://127.0.0.1:4000/mcp")).toBeDefined();
  expect(f.tokens.verify(bearer, "http://localhost:4000/mcp")).toBeDefined();
  expect(f.tokens.verify(bearer, resource)).toBeUndefined();
  expect(f.tokens.verify(bearer, "https://machine.tail1.ts.net:4443/mcp")).toBeUndefined();
});

test("a refresh token presented by another client or at another resource changes nothing", () => {
  const f = grantFixture();
  const grant = f.grants.create(draft());
  const pair = f.tokens.issuePair(grant, resource);
  expect(f.tokens.rotate(pair.refreshToken, { ...at, clientId: "other" })).toEqual({
    refused: "mismatch",
  });
  expect(
    f.tokens.rotate(pair.refreshToken, { ...at, resource: "https://other.example/mcp" }),
  ).toEqual({ refused: "mismatch" });
  expect(f.revoked).toEqual([]);
  const next = f.tokens.rotate(pair.refreshToken, at);
  if ("refused" in next) throw new Error(next.refused);
  expect(f.tokens.verify(next.accessToken, resource)?.id).toBe(grant.id);
});
