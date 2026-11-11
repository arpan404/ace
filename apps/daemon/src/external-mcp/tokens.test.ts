import { expect, test } from "vitest";
import { accessTokenTtlMs, refreshGraceMs, spentRefreshKeptMs } from "./tokens.ts";
import { draft, grantFixture } from "./grant-test-support.ts";

test("an access token works for an hour and no longer", () => {
  const f = grantFixture();
  const grant = f.grants.create(draft());
  const pair = f.tokens.issuePair(grant);
  expect(f.tokens.verify(pair.accessToken)?.id).toBe(grant.id);
  f.clock.now += accessTokenTtlMs - 1;
  expect(f.tokens.verify(pair.accessToken)?.id).toBe(grant.id);
  f.clock.now += 1;
  expect(f.tokens.verify(pair.accessToken)).toBeUndefined();
});

test("no token outlives its grant's expiry", () => {
  const f = grantFixture();
  const grant = f.grants.create(draft({ expiresAt: f.clock.now + 10 * 60_000 }));
  const pair = f.tokens.issuePair(grant);
  const bearer = f.tokens.issueBearer(grant);
  expect(pair.accessExpiresAt).toBe(grant.expiresAt);
  f.clock.now += 10 * 60_000;
  expect(f.tokens.verify(pair.accessToken)).toBeUndefined();
  expect(f.tokens.verify(bearer)).toBeUndefined();
  expect(f.tokens.rotate(pair.refreshToken)).toEqual({ refused: "expired" });
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
  const first = f.tokens.issuePair(grant);
  const second = f.tokens.rotate(first.refreshToken);
  if ("refused" in second) throw new Error(`refused: ${second.refused}`);
  expect(second.refreshToken).not.toBe(first.refreshToken);
  expect(f.tokens.verify(second.accessToken)?.id).toBe(grant.id);
  // A refresh token is never accepted as a bearer.
  expect(f.tokens.verify(second.refreshToken)).toBeUndefined();
  const third = f.tokens.rotate(second.refreshToken);
  expect("accessToken" in third).toBe(true);
});

test("presenting a refresh token traded more than a minute ago revokes the whole grant", () => {
  const f = grantFixture();
  const grant = f.grants.create(draft());
  const first = f.tokens.issuePair(grant);
  const second = f.tokens.rotate(first.refreshToken);
  if ("refused" in second) throw new Error("first rotation refused");
  f.clock.now += refreshGraceMs + 1;
  expect(f.tokens.rotate(first.refreshToken)).toEqual({ refused: "reused" });
  expect(f.revoked).toEqual([grant.id]);
  expect(f.grants.get(grant.id)?.revokedAt).toBe(f.clock.now);
  // The legitimate holder's newer tokens die with the grant.
  expect(f.tokens.verify(second.accessToken)).toBeUndefined();
  expect(f.tokens.rotate(second.refreshToken)).toMatchObject({ refused: expect.any(String) });
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
  const pair = f.tokens.issuePair(grant);
  const reopened = f.open();
  expect(reopened.tokens.verify(pair.accessToken)).toMatchObject({
    id: grant.id,
    scopes: ["threads:read", "browser"],
  });
  expect("accessToken" in reopened.tokens.rotate(pair.refreshToken)).toBe(true);
});

test("tokens are stored only as hashes", () => {
  const f = grantFixture();
  const grant = f.grants.create(draft());
  const pair = f.tokens.issuePair(grant);
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
  expect(f.tokens.rotate("a".repeat(43))).toEqual({ refused: "unknown" });
});

test("a client that lost its /token reply may trade the same refresh token again within a minute", () => {
  const f = grantFixture();
  const grant = f.grants.create(draft());
  const first = f.tokens.issuePair(grant);
  const lost = f.tokens.rotate(first.refreshToken);
  if ("refused" in lost) throw new Error("first rotation refused");
  f.clock.now += refreshGraceMs;
  const retried = f.tokens.rotate(first.refreshToken);
  if ("refused" in retried) throw new Error(`retry refused: ${retried.refused}`);
  expect(f.revoked).toEqual([]);
  expect(f.tokens.verify(retried.accessToken)?.id).toBe(grant.id);
  // The pair whose reply never arrived stops working, without costing the grant.
  expect(f.tokens.verify(lost.accessToken)).toBeUndefined();
  expect(f.tokens.rotate(lost.refreshToken)).toEqual({ refused: "unknown" });
  expect(f.grants.live(grant.id)).toBeDefined();
  expect("accessToken" in f.tokens.rotate(retried.refreshToken)).toBe(true);
});

test("a refresh token traded twice since is reuse, even within the minute", () => {
  const f = grantFixture();
  const grant = f.grants.create(draft());
  const first = f.tokens.issuePair(grant);
  const second = f.tokens.rotate(first.refreshToken);
  if ("refused" in second) throw new Error("refused");
  expect("accessToken" in f.tokens.rotate(second.refreshToken)).toBe(true);
  expect(f.tokens.rotate(first.refreshToken)).toEqual({ refused: "reused" });
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
  const first = f.tokens.issuePair(grant);
  const second = f.tokens.rotate(first.refreshToken);
  if ("refused" in second) throw new Error("refused");
  const spent = () =>
    f.db
      .prepare("SELECT COUNT(*) AS n FROM outside_grant_tokens WHERE rotated_at IS NOT NULL")
      .get()?.["n"];
  expect(spent()).toBe(1);
  f.clock.now += spentRefreshKeptMs;
  expect("accessToken" in f.tokens.rotate(second.refreshToken)).toBe(true);
  // The first is gone; the one just traded is kept.
  expect(spent()).toBe(1);
  expect(f.tokens.rotate(first.refreshToken)).toEqual({ refused: "unknown" });
  expect(f.grants.live(grant.id)).toBeDefined();
});
