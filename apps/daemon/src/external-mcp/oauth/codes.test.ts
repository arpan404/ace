import { createHash, randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { AuthorizationCodes, codeTtlMs, pkceMatches } from "./codes.ts";

const verifier = "v".repeat(20) + "-._~" + "x".repeat(30);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const binding = {
  grantId: "grant-1",
  clientId: "https://client.example/meta.json",
  redirectUri: "https://client.example/callback",
  challenge,
  resource: "https://relay.example/m/h/mcp",
};
const presented = {
  clientId: binding.clientId,
  redirectUri: binding.redirectUri,
  verifier,
  resource: binding.resource,
};
function codes() {
  const clock = { now: 1_000 };
  return { clock, codes: new AuthorizationCodes({ now: () => clock.now, random: randomBytes }) };
}

test("an S256 verifier matches only its own challenge", () => {
  expect(pkceMatches(verifier, challenge)).toBe(true);
  expect(pkceMatches(`${verifier}a`, challenge)).toBe(false);
  // Too short to be a verifier, even when it hashes right.
  const short = "abc";
  expect(pkceMatches(short, createHash("sha256").update(short).digest("base64url"))).toBe(false);
});

test("a code trades once for its grant", () => {
  const f = codes();
  const code = f.codes.issue(binding);
  expect(f.codes.redeem(code, presented)).toEqual({ grantId: "grant-1" });
  expect(f.codes.redeem(code, presented)).toMatchObject({ refused: expect.any(String) });
});

test("a code expires after a minute", () => {
  const f = codes();
  const code = f.codes.issue(binding);
  f.clock.now += codeTtlMs;
  expect(f.codes.redeem(code, presented)).toMatchObject({ refused: expect.any(String) });
});

test("a code presented with another client, redirect, resource or verifier is refused and used up", () => {
  for (const change of [
    { clientId: "https://other.example/meta.json" },
    { redirectUri: "https://client.example/other" },
    { resource: "http://127.0.0.1:4100/mcp" },
    { verifier: "w".repeat(43) },
  ]) {
    const f = codes();
    const code = f.codes.issue(binding);
    expect(f.codes.redeem(code, { ...presented, ...change })).toMatchObject({
      refused: expect.any(String),
    });
    expect(f.codes.redeem(code, presented), JSON.stringify(change)).toMatchObject({
      refused: expect.any(String),
    });
  }
});

test("a code presented again names the grant it was issued for, so its tokens can end", () => {
  const f = codes();
  const code = f.codes.issue(binding);
  expect(f.codes.redeem(code, presented)).toEqual({ grantId: "grant-1" });
  expect(f.codes.redeem(code, presented)).toMatchObject({ reused: "grant-1" });
  // A code nobody ever issued names nothing.
  expect(f.codes.redeem("never-issued", presented)).not.toHaveProperty("reused");
});
