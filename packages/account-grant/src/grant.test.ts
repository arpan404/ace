import { expect, it } from "vitest";
import {
  GRANT_LIFETIME_MS,
  grantFromSubprotocols,
  grantPublicKey,
  signGrant,
  signCloudGrant,
  signMarketGrant,
  signStandingGrant,
  grantLifetimeMs,
  grantSignInAge,
  verifyCloudGrant,
  verifyGrant,
  verifyMarketGrant,
  verifyStandingGrant,
} from "./index.ts";
import { encodeBase64url } from "./index.ts";
import {
  exchangeKeyPair,
  machineCredentialProof,
  machineCredentialProofValid,
} from "./machine-proof.ts";
import { x25519 } from "@noble/curves/ed25519.js";

const key = { id: "k1", privateKey: crypto.getRandomValues(new Uint8Array(32)) };
const other = { id: "k2", privateKey: crypto.getRandomValues(new Uint8Array(32)) };
const keys = { keys: [grantPublicKey(key)] };
const claims = {
  kind: "device" as const,
  account: "user_1",
  subject: "phone",
  iat: 1_000,
  exp: 1_000 + GRANT_LIFETIME_MS,
};

it("a grant signed by a published key verifies with its claims until it expires", () => {
  const token = signGrant(claims, key);
  expect(verifyGrant(token, keys, 2_000, "device")).toMatchObject({
    account: "user_1",
    subject: "phone",
    kid: "k1",
  });
  expect(() => verifyGrant(token, keys, claims.exp, "device")).toThrow("expired");
  expect(() => verifyGrant(token, keys, 2_000, "machine")).toThrow("kind");
});

it("a grant is refused when signed by an unpublished key, altered, or issued for too long", () => {
  expect(() => verifyGrant(signGrant(claims, other), keys, 2_000, "device")).toThrow("Unknown");
  const forged = signGrant({ ...claims, kind: "device" }, { ...other, id: "k1" });
  expect(() => verifyGrant(forged, keys, 2_000, "device")).toThrow("signature");
  const [body, signature] = signGrant(claims, key).split(".");
  const altered = JSON.parse(atob(body!.replaceAll("-", "+").replaceAll("_", "/"))) as object;
  const swapped = btoa(JSON.stringify({ ...altered, account: "user_2" }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  expect(() => verifyGrant(`${swapped}.${signature}`, keys, 2_000, "device")).toThrow();
  const long = signGrant({ ...claims, exp: claims.iat + GRANT_LIFETIME_MS + 1 }, key);
  expect(() => verifyGrant(long, keys, 2_000, "device")).toThrow("lifetime");
  expect(() => verifyGrant("not a grant", keys, 2_000, "device")).toThrow("Malformed");
});

it("a format 2 grant says whose session asked and for which daemon, and neither format passes for the other", () => {
  const { kind: _kind, ...rest } = claims;
  const host = "H".repeat(52);
  const deviceKey = "k".repeat(87);
  const person = signStandingGrant({ ...rest, standing: "person", host, key: deviceKey }, key);
  expect(verifyStandingGrant(person, keys, 2_000)).toMatchObject({
    v: 2,
    kind: "device",
    aud: "ace-daemon",
    standing: "person",
    host,
    key: deviceKey,
  });
  // A person's grant always names its daemon and device key.
  expect(() => signStandingGrant({ ...rest, standing: "person" }, key)).toThrow();
  const machine = signStandingGrant({ ...rest, standing: "machine" }, key);
  expect(verifyStandingGrant(machine, keys, 2_000).standing).toBe("machine");
  // An older daemon's strict format 1 parser refuses format 2; format 2 refuses format 1.
  expect(() => verifyGrant(machine, keys, 2_000, "device")).toThrow("Malformed");
  expect(() => verifyStandingGrant(signGrant(claims, key), keys, 2_000)).toThrow("Malformed");
  expect(() => verifyStandingGrant(person, { keys: [grantPublicKey(other)] }, 2_000)).toThrow(
    "Unknown",
  );
  expect(() => verifyStandingGrant(person, keys, claims.exp)).toThrow("expired");
  expect(grantLifetimeMs(person)).toBe(GRANT_LIFETIME_MS);
});

it("a machine credential is asked for only with the host key its host id names", () => {
  const exchange = exchangeKeyPair(new Uint8Array(32).fill(1));
  const host = { privateKey: new Uint8Array(32).fill(2) };
  const hostKey = encodeBase64url(x25519.getPublicKey(host.privateKey));
  const proof = machineCredentialProof({
    hostPrivateKey: host.privateKey,
    exchangeKey: exchange.publicKey,
    hostId: "H".repeat(52),
    credential: "c".repeat(43),
  });
  const valid = (overrides: Partial<{ hostKey: string; hostId: string; credential: string }>) =>
    machineCredentialProofValid({
      exchangePrivateKey: exchange.privateKey,
      hostKey,
      hostId: "H".repeat(52),
      credential: "c".repeat(43),
      proof,
      ...overrides,
    });
  expect(valid({})).toBe(true);
  // Another host key, another host id, or another credential: the proof is for none of them.
  expect(valid({ hostKey: encodeBase64url(x25519.getPublicKey(new Uint8Array(32).fill(3))) })).toBe(
    false,
  );
  expect(valid({ hostId: "G".repeat(52) })).toBe(false);
  expect(valid({ credential: "d".repeat(43) })).toBe(false);
});

it("the grant offered among WebSocket subprotocols is found by its prefix", () => {
  expect(grantFromSubprotocols("chat, ace.grant.abc.def")).toBe("abc.def");
  expect(grantFromSubprotocols("chat")).toBeUndefined();
  expect(grantFromSubprotocols(null)).toBeUndefined();
});

it("the shared test vectors give the same verdicts here", async () => {
  const { readFile } = await import("node:fs/promises");
  const vectors = JSON.parse(
    await readFile(new URL("../test-vectors.json", import.meta.url), "utf8"),
  ) as {
    keys: { keys: { id: string; publicKey: string }[] };
    now: number;
    valid: { token: string; kind: "machine" | "device"; account: string; subject: string }[];
    invalid: { why: string; token: string; kind: "machine" | "device"; now?: number }[];
  };
  for (const each of vectors.valid)
    expect(verifyGrant(each.token, vectors.keys, vectors.now, each.kind)).toMatchObject({
      account: each.account,
      subject: each.subject,
    });
  for (const each of vectors.invalid)
    expect(
      () => verifyGrant(each.token, vectors.keys, each.now ?? vectors.now, each.kind),
      each.why,
    ).toThrow();
});

it("cloud credentials cannot be replayed as relay host grants", () => {
  const token = signCloudGrant({ ...claims, kind: "machine" }, key);
  expect(grantLifetimeMs(token)).toBe(GRANT_LIFETIME_MS);
  expect(() => verifyGrant(token, keys, 2_000, "machine")).toThrow("Malformed");
});

it("ace cloud accepts only a cloud credential: a relay machine or device grant is refused", () => {
  const cloud = signCloudGrant({ ...claims, kind: "machine" }, key);
  expect(verifyCloudGrant(cloud, keys, 2_000)).toMatchObject({
    account: "user_1",
    aud: "cloud.acehq.dev",
    purpose: "spade-cloud",
  });
  expect(() => verifyCloudGrant(cloud, keys, claims.exp)).toThrow("expired");
  expect(() =>
    verifyCloudGrant(signCloudGrant({ ...claims, kind: "machine" }, other), keys, 2_000),
  ).toThrow("Unknown");
  for (const kind of ["machine", "device"] as const)
    expect(() => verifyCloudGrant(signGrant({ ...claims, kind }, key), keys, 2_000)).toThrow(
      "Malformed",
    );
});

const marketClaims = { iss: "cloud.acehq.dev", emailVerified: true, authAt: 900 };

it("the market accepts only a market grant from its issuer, and no one else accepts it", () => {
  expect(() =>
    verifyMarketGrant(
      signMarketGrant({ ...claims, ...marketClaims, iss: "other.example" }, key),
      keys,
      2_000,
    ),
  ).toThrow("issuer");
  for (const kind of ["machine", "device"] as const) {
    const market = signMarketGrant({ ...claims, ...marketClaims, kind }, key);
    expect(verifyMarketGrant(market, keys, 2_000)).toMatchObject({
      account: "user_1",
      aud: "market.acehq.dev",
      purpose: "market-publish",
    });
    expect(() => verifyGrant(market, keys, 2_000, kind)).toThrow("Malformed");
    expect(() => verifyCloudGrant(market, keys, 2_000)).toThrow("Malformed");
    expect(() => verifyMarketGrant(signGrant({ ...claims, kind }, key), keys, 2_000)).toThrow(
      "Malformed",
    );
  }
  expect(() =>
    verifyMarketGrant(signCloudGrant({ ...claims, kind: "machine" }, key), keys, 2_000),
  ).toThrow("Malformed");
  expect(() =>
    verifyMarketGrant(signMarketGrant({ ...claims, ...marketClaims }, key), keys, claims.exp),
  ).toThrow("expired");
});

it("a market grant says how long before it was issued its sign-in happened; others say nothing", () => {
  // Issued at 1,000 for a sign-in at 900, both on the backend's clock.
  expect(grantSignInAge(signMarketGrant({ ...claims, ...marketClaims }, key))).toBe(100);
  expect(grantSignInAge(signGrant(claims, key))).toBeUndefined();
  expect(grantSignInAge("not.a-grant")).toBeUndefined();
  expect(grantSignInAge("")).toBeUndefined();
});

it("a grant, key or proof has one spelling: another base64url spelling of the same bytes is refused", () => {
  const token = signGrant(claims, key);
  const [body = "", signature = ""] = token.split(".");
  // The last character of an unpadded group carries unused low bits; set one.
  const last = signature.at(-1) ?? "A";
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const respelled = `${signature.slice(0, -1)}${alphabet[alphabet.indexOf(last) ^ 1]}`;
  expect(verifyGrant(token, keys, 2_000, "device").account).toBe("user_1");
  expect(() => verifyGrant(`${body}.${respelled}`, keys, 2_000, "device")).toThrow();
});
