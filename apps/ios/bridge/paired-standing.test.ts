import { expect, test } from "vitest";
import type { StandingChallenge } from "@ace/client";
import { decodeBase64url, encodeBase64url, pairedStandingText } from "@ace/account-grant";
import { keepPairedStanding, type PairedStanding } from "./paired-standing.ts";

/** A P-256 key standing in for the phone's Secure Enclave key: it signs as `standing.sign` does. */
async function enclaveKey() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ]);
  const signed: string[] = [];
  return {
    signed,
    sign: async (text: string) => {
      signed.push(text);
      const bytes = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        pair.privateKey,
        new TextEncoder().encode(text),
      );
      return encodeBase64url(new Uint8Array(bytes));
    },
    /** What the daemon checks: this key's signature over that socket's own challenge. */
    verifies: (proof: string, challenge: StandingChallenge) =>
      crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        pair.publicKey,
        new Uint8Array(decodeBase64url(proof)),
        new TextEncoder().encode(
          pairedStandingText({
            host: challenge.host,
            nonce: challenge.nonce,
            binding: challenge.binding,
            deviceId: challenge.device,
          }),
        ),
      ),
  };
}

/** A paired machine's client whose socket the test replaces; `answer` is the daemon's verdict. */
function machine(answer: (proof: string, challenge: StandingChallenge) => Promise<boolean>) {
  let challenge: StandingChallenge | undefined;
  const listeners = new Set<() => void>();
  const sent: { type: string; proof: string }[] = [];
  return {
    sent,
    socket(next: StandingChallenge | undefined) {
      challenge = next;
      for (const listener of listeners) listener();
    },
    api: {
      standingChallenge: () => ({
        getSnapshot: () => challenge,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => void listeners.delete(listener);
        },
      }),
      request: async (message: { type: string; proof: string }) => {
        sent.push(message);
        const asked = challenge;
        const ok = asked !== undefined && (await answer(message.proof, asked));
        return {
          type: "account.standing.result",
          requestId: "r",
          result: ok
            ? { ok: true, until: Number.MAX_SAFE_INTEGER }
            : { ok: false, code: "unauthorized", message: "No" },
        };
      },
    },
  };
}

const socket = (nonce: string, binding?: string): StandingChallenge => ({
  host: "H".repeat(52),
  nonce,
  binding,
  device: "phone-device",
});
/** Lets the signing and the daemon's check, both real WebCrypto, finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

test("a direct socket's proof signs the paired text over its own nonce, with no channel named", async () => {
  const key = await enclaveKey();
  const m = machine((proof, asked) => key.verifies(proof, asked));
  const reports: PairedStanding[] = [];
  m.socket(socket("nonce-1"));
  keepPairedStanding(m.api as never, key.sign, (state) => reports.push(state));
  await settle();
  expect(key.signed).toEqual([
    `ace-paired-standing/v1\n${"H".repeat(52)}\nnonce-1\nnone\nphone-device`,
  ]);
  expect(m.sent.map((message) => message.type)).toEqual(["device.standing"]);
  expect(reports).toEqual(["proven"]);
});

test("a proof made for one socket fails on the next, which proves again with its own", async () => {
  const key = await enclaveKey();
  const m = machine((proof, asked) => key.verifies(proof, asked));
  const reports: PairedStanding[] = [];
  m.socket(socket("nonce-1", "channel-1"));
  keepPairedStanding(m.api as never, key.sign, (state) => reports.push(state));
  await settle();
  const first = m.sent[0]!.proof;
  // A reconnect: another nonce and another channel. The first socket's proof proves nothing there.
  const second = socket("nonce-2", "channel-2");
  expect(await key.verifies(first, second)).toBe(false);
  expect(await key.verifies(first, socket("nonce-1", "channel-2"))).toBe(false);
  m.socket(second);
  await settle();
  expect(m.sent).toHaveLength(2);
  expect(await key.verifies(m.sent[1]!.proof, second)).toBe(true);
  expect(reports).toEqual(["proven", "proven"]);
});

test("a phone with no key for the machine sends nothing and says its standing is missing", async () => {
  const m = machine(async () => true);
  const reports: PairedStanding[] = [];
  m.socket(socket("nonce-1"));
  keepPairedStanding(
    m.api as never,
    async () => Promise.reject(new Error("unsupported")),
    (state) => reports.push(state),
  );
  await settle();
  expect(m.sent).toEqual([]);
  expect(reports).toEqual(["missing"]);
});

test("a daemon that refuses the proof (an ordinary link's pairing) leaves the standing missing", async () => {
  const key = await enclaveKey();
  const m = machine(async () => false);
  const reports: PairedStanding[] = [];
  m.socket(socket("nonce-1"));
  keepPairedStanding(m.api as never, key.sign, (state) => reports.push(state));
  await settle();
  expect(reports).toEqual(["missing"]);
});

test("a proof signed for a socket that was replaced meanwhile is never sent", async () => {
  const key = await enclaveKey();
  const m = machine((proof, asked) => key.verifies(proof, asked));
  const reports: PairedStanding[] = [];
  let release: () => void = () => {};
  const slow = (text: string) =>
    new Promise<string>((resolve) => {
      release = () => void key.sign(text).then(resolve);
    });
  m.socket(socket("nonce-1"));
  keepPairedStanding(m.api as never, slow, (state) => reports.push(state));
  m.socket(undefined);
  release();
  await settle();
  await settle();
  expect(m.sent).toEqual([]);
  expect(reports).toEqual([]);
});

test("an older daemon with no challenge is asked nothing", async () => {
  const m = machine(async () => true);
  const reports: PairedStanding[] = [];
  keepPairedStanding(
    m.api as never,
    async () => "sig",
    (state) => reports.push(state),
  );
  await settle();
  expect(m.sent).toEqual([]);
  expect(reports).toEqual([]);
});
