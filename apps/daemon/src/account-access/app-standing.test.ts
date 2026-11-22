import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { encodeBase64url } from "@ace/account-grant";
import {
  appSocketTag,
  enrollAction,
  socketsTarget,
  TAG_FRESH_MS,
  type TaggedSocket,
} from "@ace/account-grant/app-channel";
import {
  deviceKeyId,
  statementText,
  type PersonStatement,
} from "@ace/account-grant/person-statement";
import { APP_STANDING_MAX_SOCKETS, AppStandingChallenge } from "@ace/protocol";
import { appStandingDesk, ENROLL_SIGN_IN_MS, type AppSocket } from "./app-standing.ts";

/*
 * The daemon's side of the app's standing (ADR 0190, amendment 1): tags name one fresh socket,
 * proofs bind each socket's own connection nonce, enrollment needs the account backend's word on
 * a recent sign-in, and a statement names at most a batch of sockets.
 */

const host = "H".repeat(52);
const account = "user_1";

async function device() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ]);
  const raw = encodeBase64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  const sign = async (text: string) =>
    encodeBase64url(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          pair.privateKey,
          new TextEncoder().encode(text),
        ),
      ),
    );
  return { raw, id: await deviceKeyId(raw), sign };
}

/** A socket the server attached under `tag`, recording what it was given. */
function socketOf(connection: string, grantProven = false) {
  const given: string[] = [];
  const s: AppSocket & { given: string[] } = {
    connection,
    given,
    grantApp: (key) => {
      given.push(key);
      return true;
    },
    grantProven: () => (grantProven ? 1 : undefined),
    dropApp: () => {},
  };
  return s;
}

/** A desk on a fake machine: its keys, its clock, and grants the "backend" vouched for. */
function setup() {
  let now = 1_800_000_000_000;
  const keys: string[] = [];
  /** Sign-in grants, as the backend would mint them: `grant:<n>` → what it says. */
  const grants = new Map<string, { account: string; authAt: number; action: string }>();
  const desk = appStandingDesk({
    now: () => now,
    nonce: () => randomBytes(24).toString("base64url"),
    machine: () => ({
      relayHostId: () => host,
      relayShared: async () => new Uint8Array(32).fill(1),
      signInGrant: (token) => grants.get(token),
      ownerAccount: () => account,
      ownerOrg: () => undefined,
      ownerGeneration: () => 1,
      appKeys: () => keys,
      addAppKey: async (key) => {
        keys.push(key);
        return true;
      },
      removeAppKey: async () => {},
    }),
  });
  const challenge = async (tags: string[]) =>
    AppStandingChallenge.parse(
      await desk.challenge({ ephemeral: "e".repeat(43), tags: tags.slice(0, 16) }),
    );
  const send = async (
    purpose: PersonStatement["purpose"],
    signer: Awaited<ReturnType<typeof device>>,
    sockets: TaggedSocket[],
    nonce: string,
    signIn?: string,
  ) => {
    const text = statementText({
      account,
      device: signer.id,
      purpose,
      action: "socket",
      target: socketsTarget(sockets),
      audience: host,
      nonce,
      iat: now,
      exp: now + 30_000,
    });
    const body = {
      statement: text,
      proof: await signer.sign(text),
      key: signer.raw,
      sockets,
      ...(signIn ? { signIn } : {}),
    };
    return purpose === "enroll" ? desk.enroll(body) : desk.prove(body);
  };
  return {
    desk,
    keys,
    grants,
    socket: socketOf,
    challenge,
    send,
    tag: () => appSocketTag(now, randomBytes(32)),
    later: (ms: number) => (now += ms),
    now: () => now,
  };
}

test("a tag names one fresh socket: a stale tag, or a second socket with a used one, gets nothing", () => {
  const t = setup();
  const tag = t.tag();
  expect(t.desk.attach(tag, t.socket("c".repeat(22)))).toBeDefined();
  // The same tag on another connection, while the first is open and after it closed.
  expect(t.desk.attach(tag, t.socket("d".repeat(22)))).toBeUndefined();
  t.later(TAG_FRESH_MS * 3);
  expect(t.desk.attach(tag, t.socket("d".repeat(22)))).toBeUndefined();
  expect(
    t.desk.attach(
      appSocketTag(t.now() - TAG_FRESH_MS - 1, randomBytes(32)),
      t.socket("e".repeat(22)),
    ),
  ).toBeUndefined();
});

test("a proof binds each socket's own connection nonce, and names at most a batch of sockets", async () => {
  const t = setup();
  const key = await device();
  t.keys.push(key.raw);
  const tag = t.tag();
  const first = t.socket("c".repeat(22));
  t.desk.attach(tag, first);
  const asked = await t.challenge([tag]);
  expect(asked.sockets).toEqual([{ tag, connection: "c".repeat(22) }]);
  expect(await t.send("standing", key, asked.sockets, asked.nonce)).toBe(1);
  // A statement naming the tag with another connection's nonce proves nothing.
  const again = await t.challenge([tag]);
  expect(await t.send("standing", key, [{ tag, connection: "x".repeat(22) }], again.nonce)).toBe(0);
  // More sockets than a batch holds is no statement at all.
  const many = Array.from({ length: APP_STANDING_MAX_SOCKETS + 1 }, () => {
    const each = t.tag();
    t.desk.attach(each, t.socket(randomBytes(16).toString("base64url")));
    return each;
  });
  const batch = await t.challenge(many);
  expect(batch.sockets).toHaveLength(APP_STANDING_MAX_SOCKETS);
  const over = [...batch.sockets, { tag: many.at(-1) ?? "", connection: "y".repeat(22) }];
  expect(await t.send("standing", key, over, batch.nonce)).toBe(0);
  expect(first.given).toEqual([key.raw]);
});

test("enrolling takes the account backend's word on a sign-in from the last ten minutes, naming this key and challenge", async () => {
  const t = setup();
  const key = await device();
  const tag = t.tag();
  t.desk.attach(tag, t.socket("c".repeat(22), true));
  const vouch = (
    nonce: string,
    change: Partial<{ account: string; authAt: number; action: string }> = {},
  ) => {
    const token = `grant:${t.grants.size}`;
    t.grants.set(token, {
      account,
      authAt: t.now(),
      action: enrollAction({ host, device: key.id, nonce }),
      ...change,
    });
    return token;
  };
  for (const change of [
    { authAt: t.now() - ENROLL_SIGN_IN_MS - 1 },
    { account: "user_2" },
    { action: "ace-enroll-device/v1 another" },
  ]) {
    const asked = await t.challenge([tag]);
    expect(
      await t.send("enroll", key, asked.sockets, asked.nonce, vouch(asked.nonce, change)),
    ).toBe(false);
  }
  const unvouched = await t.challenge([tag]);
  expect(await t.send("enroll", key, unvouched.sockets, unvouched.nonce)).toBe(false);
  expect(t.keys).toEqual([]);
  const asked = await t.challenge([tag]);
  expect(await t.send("enroll", key, asked.sockets, asked.nonce, vouch(asked.nonce))).toBe(true);
  expect(t.keys).toEqual([key.raw]);
});
