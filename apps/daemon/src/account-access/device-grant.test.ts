import { expect, it } from "vitest";
import {
  GRANT_LIFETIME_MS,
  grantPublicKey,
  signGrant,
  signStandingGrant,
} from "@ace/account-grant";
import { deviceGrantVerdict, personStanding } from "./device-grant.ts";

const key = { id: "k1", privateKey: new Uint8Array(32).fill(7) };
const keys = { keys: [grantPublicKey(key)] };
const issued = 1_000_000;
const grant = (claims: Partial<{ kind: "device" | "machine"; account: string; subject: string }>) =>
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
    ...overrides,
  });

it("a device grant for this machine's account and the hello's device opens the machine", () => {
  expect(check(grant({}))).toMatchObject({ accepted: true, claims: { account: "user_1" } });
});

it("a grant is refused for another account, another device, a machine grant or after expiry", () => {
  expect(check(grant({ account: "user_2" }))).toEqual({
    accepted: false,
    reason: "other_account",
  });
  expect(check(grant({ subject: "laptop" }))).toEqual({ accepted: false, reason: "other_device" });
  expect(check(grant({ kind: "machine" }))).toEqual({ accepted: false, reason: "invalid" });
  expect(check(grant({}), { now: issued + GRANT_LIFETIME_MS })).toEqual({
    accepted: false,
    reason: "expired",
  });
  expect(check("garbage")).toEqual({ accepted: false, reason: "invalid" });
});

it("no grant opens a machine that is signed out of ace", () => {
  expect(check(grant({}), { account: undefined })).toEqual({
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

const standing = (
  claims: Partial<{ standing: "person" | "machine"; account: string; subject: string }> = {},
  signer = key,
) =>
  signStandingGrant(
    {
      standing: "person",
      account: "user_1",
      subject: "phone",
      iat: issued,
      exp: issued + GRANT_LIFETIME_MS,
      ...claims,
    },
    signer,
  );
const forger = { id: "k1", privateKey: new Uint8Array(32).fill(9) };

it.each([
  { case: "a person's standing grant", token: standing(), person: true },
  { case: "no standing grant (an older client, or one left out)", token: undefined, person: false },
  { case: "a machine's standing grant", token: standing({ standing: "machine" }), person: false },
  { case: "another account's", token: standing({ account: "user_2" }), person: false },
  { case: "another device's", token: standing({ subject: "laptop" }), person: false },
  {
    case: "one signed by a key this build doesn't pin",
    token: standing({}, forger),
    person: false,
  },
  { case: "a format 1 device grant in its place", token: grant({}), person: false },
  { case: "garbage", token: "not.a-grant", person: false },
])("an account device speaks for the person only with $case: $person", ({ token, person }) => {
  expect(
    personStanding(token, { keys, now: issued + 1_000, account: "user_1", deviceId: "phone" }),
  ).toBe(person);
});

it("an expired standing grant gives no person standing", () => {
  expect(
    personStanding(standing(), {
      keys,
      now: issued + GRANT_LIFETIME_MS,
      account: "user_1",
      deviceId: "phone",
    }),
  ).toBe(false);
});
