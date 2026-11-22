import { expect, test } from "vitest";
import type { StandingChallenge } from "@ace/client";
import type { AppStandingKey } from "./app-standing-key.ts";
import { keepStanding, type StandingProver } from "./standing-keeper.ts";
import { appProver, keepAppKey } from "./window-prover.ts";

/*
 * The desktop app's kept key (ADR 0190, amendment 1): the first socket proves the owner's grant
 * and keeps the key; every later socket proves with the key alone.
 */

const origin = "https://acehq.dev";
const encode = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const signedIn = () => "user_1";

/** main's key store, one key per account, signing with a real P-256 key. */
function mainProcess(): AppStandingKey & { made: number } {
  const keys = new Map<string, { pair: CryptoKeyPair; raw: string }>();
  const store = {
    made: 0,
    async key(_origin: string, account: string) {
      const held = keys.get(account);
      if (held) return held.raw;
      const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
        "sign",
        "verify",
      ]);
      const raw = encode(await crypto.subtle.exportKey("raw", pair.publicKey));
      keys.set(account, { pair, raw });
      store.made++;
      return raw;
    },
    async sign(_origin: string, account: string, text: string) {
      const held = keys.get(account);
      if (!held) return null;
      const proof = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        held.pair.privateKey,
        new TextEncoder().encode(text),
      );
      return { key: held.raw, proof: encode(proof) };
    },
  };
  return store;
}

/** A daemon that takes any grant proof, keeps keys it is given, and takes a kept key's proof. */
function daemon() {
  let challenge: StandingChallenge | undefined;
  const listeners = new Set<() => void>();
  const kept = new Set<string>();
  const proven: string[] = [];
  return {
    proven,
    socket(nonce: string) {
      challenge = { host: "H".repeat(52), nonce, binding: undefined, device: "window" };
      for (const listener of listeners) listener();
    },
    api: {
      state: "ready" as const,
      standingChallenge: () => ({
        getSnapshot: () => challenge,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => void listeners.delete(listener);
        },
      }),
      request: async (message: { type: string; key?: string }) => {
        if (message.type === "account.owner.key") {
          if (message.key) kept.add(message.key);
          return { type: "account.owner.key.result", requestId: "k", ok: true };
        }
        const ok =
          message.type === "account.standing" ||
          (message.type === "account.standing.app" && kept.has(message.key ?? ""));
        if (ok) proven.push(`${message.type} ${challenge?.nonce}`);
        return {
          type: "account.standing.result",
          requestId: "s",
          result: ok ? { ok: true, until: 1 } : { ok: false, code: "unauthorized", message: "" },
        };
      },
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const timers = { set: () => () => {} };

test("a desktop window proves the owner's grant once, then every new socket proves with the app's kept key", async () => {
  const main = mainProcess();
  const d = daemon();
  let grants = 0;
  const grant: StandingProver = async (challenge) => {
    grants++;
    return { type: "account.standing", grant: `g-${challenge.nonce}`, proof: "p" };
  };
  const keeper = keepStanding(
    d.api as never,
    appProver(main, origin, signedIn),
    timers,
    grant,
    keepAppKey(d.api as never, main, origin, signedIn),
  );
  d.socket("n1");
  await settle();
  d.socket("n2");
  await settle();
  d.socket("n3");
  await settle();
  expect(d.proven).toEqual([
    "account.standing n1",
    "account.standing.app n2",
    "account.standing.app n3",
  ]);
  expect(grants).toBe(1);
  expect(main.made).toBe(1);
  keeper.stop();
});

test("the app's key signs for the window's own account only, and never on a relayed socket", async () => {
  const main = mainProcess();
  await main.key(origin, "user_1");
  const relayed = { host: "H".repeat(52), nonce: "n", binding: "noise", device: "w" };
  const loopback = { ...relayed, binding: undefined };
  expect(await appProver(main, origin, () => "user_1")(relayed)).toBeUndefined();
  expect(await appProver(main, origin, () => "user_2")(loopback)).toBeUndefined();
  expect(await appProver(main, origin, () => undefined)(loopback)).toBeUndefined();
  expect(await appProver(main, origin, () => "user_1")(loopback)).toMatchObject({
    type: "account.standing.app",
  });
});
