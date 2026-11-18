import { expect, it } from "vitest";
import {
  GRANT_LIFETIME_MS,
  grantPublicKey,
  signGrant,
  signStandingGrant,
  standingProofText,
} from "@ace/account-grant";
import { deviceGrantVerdict, provenStanding } from "./device-grant.ts";

const key = { id: "k1", privateKey: new Uint8Array(32).fill(7) };
const keys = { keys: [grantPublicKey(key)] };
const issued = 1_000_000;
const format1 = (
  claims: Partial<{ kind: "device" | "machine"; account: string; subject: string }>,
) =>
  signGrant(
    {
      kind: "device",
      account: "user_1",
      subject: "phone",
      iat: issued,
      exp: issued + GRANT_LIFETIME_MS,
      ...claims,
    },
    key,
  );
const check = (token: string, overrides: Partial<Parameters<typeof deviceGrantVerdict>[1]> = {}) =>
  deviceGrantVerdict(token, {
    keys,
    now: issued + 1_000,
    account: "user_1",
    deviceId: "phone",
    host,
    ...overrides,
  });

it("a device grant for this machine's account and the hello's device opens the machine", () => {
  expect(check(format1({}))).toMatchObject({ accepted: true, claims: { account: "user_1" } });
});

it("a grant is refused for another account, another device, a machine grant or after expiry", () => {
  expect(check(format1({ account: "user_2" }))).toEqual({
    accepted: false,
    reason: "other_account",
  });
  expect(check(format1({ subject: "laptop" }))).toEqual({
    accepted: false,
    reason: "other_device",
  });
  expect(check(format1({ kind: "machine" }))).toEqual({ accepted: false, reason: "invalid" });
  expect(check(format1({}), { now: issued + GRANT_LIFETIME_MS })).toEqual({
    accepted: false,
    reason: "expired",
  });
  expect(check("garbage")).toEqual({ accepted: false, reason: "invalid" });
});

it("no grant opens a machine that is signed out of ace", () => {
  expect(check(format1({}), { account: undefined })).toEqual({
    accepted: false,
    reason: "signed_out",
  });
});

it("a grant signed by a key the backend does not publish is refused", () => {
  const stranger = { id: "k9", privateKey: new Uint8Array(32).fill(9) };
  const token = signGrant(
    { kind: "device", account: "user_1", subject: "phone", iat: issued, exp: issued + 60_000 },
    stranger,
  );
  expect(check(token)).toEqual({ accepted: false, reason: "unknown_key" });
});

const host = "H".repeat(52);
const otherHost = "G".repeat(52);
const forger = { id: "k1", privateKey: new Uint8Array(32).fill(9) };
const encode = (bytes: ArrayBuffer) => Buffer.from(bytes).toString("base64url");

/** A device's P-256 key, as the web app keeps one. */
async function deviceKey() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ]);
  const raw = encode(await crypto.subtle.exportKey("raw", pair.publicKey));
  const sign = async (text: string) =>
    encode(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        pair.privateKey,
        new TextEncoder().encode(text),
      ),
    );
  return { raw, sign };
}

const personGrant = (
  key64: string,
  claims: Partial<{
    standing: "person" | "machine";
    account: string;
    subject: string;
    host: string;
  }> = {},
  signer = key,
) =>
  signStandingGrant(
    {
      standing: "person",
      account: "user_1",
      subject: "phone",
      host,
      key: key64,
      iat: issued,
      exp: issued + GRANT_LIFETIME_MS,
      ...claims,
    },
    signer,
  );

const prove = (
  grant: string,
  proof: string,
  overrides: Partial<Parameters<typeof provenStanding>[0]> = {},
) =>
  provenStanding({
    grant,
    proof,
    nonce: "socket-nonce",
    keys,
    now: issued + 1_000,
    account: "user_1",
    deviceId: "phone",
    host,
    ...overrides,
  });

it("a person's grant, proven with its device key over this socket's nonce, gives the person's standing until it expires", async () => {
  const device = await deviceKey();
  const token = personGrant(device.raw);
  const proof = await device.sign(standingProofText({ host, nonce: "socket-nonce", grant: token }));
  expect(await prove(token, proof)).toEqual({ until: issued + GRANT_LIFETIME_MS });
  expect(await prove(token, proof, { now: issued + GRANT_LIFETIME_MS })).toBeUndefined();
});

it("a captured person's grant or proof gives nothing on another socket, daemon or device", async () => {
  const device = await deviceKey();
  const token = personGrant(device.raw);
  const proof = await device.sign(standingProofText({ host, nonce: "socket-nonce", grant: token }));
  // Another socket's nonce, another daemon, another device id, another account.
  expect(await prove(token, proof, { nonce: "other-socket" })).toBeUndefined();
  expect(await prove(token, proof, { host: otherHost })).toBeUndefined();
  expect(await prove(token, proof, { deviceId: "laptop" })).toBeUndefined();
  expect(await prove(token, proof, { account: "user_2" })).toBeUndefined();
  // Whoever holds the grant but not the device key can't sign for this socket.
  const thief = await deviceKey();
  const forged = await thief.sign(standingProofText({ host, nonce: "socket-nonce", grant: token }));
  expect(await prove(token, forged)).toBeUndefined();
});

it.each([
  ["a machine's grant", (raw: string) => personGrant(raw, { standing: "machine" })],
  ["one for another daemon", (raw: string) => personGrant(raw, { host: otherHost })],
  ["one signed by a key this build doesn't pin", (raw: string) => personGrant(raw, {}, forger)],
  ["a format 1 device grant", () => format1({})],
])("%s never gives the person's standing", async (_case, make) => {
  const device = await deviceKey();
  const token = make(device.raw);
  const proof = await device.sign(standingProofText({ host, nonce: "socket-nonce", grant: token }));
  expect(await prove(token, proof)).toBeUndefined();
});

it("a format 2 grant admits a device as format 1 does, and one bound to another daemon doesn't", () => {
  const machine = signStandingGrant(
    {
      standing: "machine",
      account: "user_1",
      subject: "phone",
      iat: issued,
      exp: issued + GRANT_LIFETIME_MS,
    },
    key,
  );
  expect(check(machine)).toMatchObject({ accepted: true, claims: { account: "user_1" } });
  const bound = signStandingGrant(
    {
      standing: "machine",
      account: "user_1",
      subject: "phone",
      host: otherHost,
      iat: issued,
      exp: issued + GRANT_LIFETIME_MS,
    },
    key,
  );
  expect(check(bound)).toEqual({ accepted: false, reason: "other_host" });
});
