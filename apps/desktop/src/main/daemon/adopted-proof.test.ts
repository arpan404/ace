import { describe, expect, it } from "vitest";
import { appKeyPair, appSignatureProven } from "@ace/service/app-signature";
import { adoptedProofs } from "./adopted-proof.ts";
import type { LocalDaemon } from "./probe.ts";

const daemon: LocalDaemon = {
  origin: "http://127.0.0.1:4242",
  url: "ws://127.0.0.1:4242/",
  token: "a".repeat(64),
  hostId: "host-a",
};
const pair = appKeyPair(new Uint8Array(32).fill(1));

/** A daemon the app didn't start: it takes the key once `fresh` says the person signed in. */
function adopted(options: { keychain?: boolean } = {}) {
  let now = 0;
  const state = { fresh: false, asked: 0 };
  const proofs = adoptedProofs({
    pair: async () => (options.keychain === false ? undefined : pair),
    register: async (_daemon, publicKey) => {
      state.asked++;
      return state.fresh && publicKey === pair.x ? "run-1" : undefined;
    },
    now: () => now,
  });
  return { proofs, state, advance: (ms: number) => void (now += ms) };
}

describe("the page's proof for a daemon the app didn't start", () => {
  it("is the app's signature for that daemon's run and port, once its key is registered", async () => {
    const { proofs, state } = adopted();
    state.fresh = true;
    const handed = await proofs.withProof(daemon);
    expect(appSignatureProven([pair.x], 4242, "run-1", handed.appProof ?? "")).toBe(true);
  });

  it("is absent until the person signs in, and the daemon isn't asked again for a minute", async () => {
    const { proofs, state, advance } = adopted();
    expect((await proofs.withProof(daemon)).appProof).toBeUndefined();
    await proofs.withProof(daemon);
    expect(state.asked).toBe(1);
    advance(60_000);
    await proofs.withProof(daemon);
    expect(state.asked).toBe(2);
  });

  it("is asked for again at once after the person signs in through the app", async () => {
    const { proofs, state } = adopted();
    await proofs.withProof(daemon);
    state.fresh = true;
    proofs.retry();
    expect((await proofs.withProof(daemon)).appProof).toBeDefined();
  });

  it("is never made without a keychain to keep the key in", async () => {
    const { proofs, state } = adopted({ keychain: false });
    state.fresh = true;
    expect((await proofs.withProof(daemon)).appProof).toBeUndefined();
    expect(state.asked).toBe(0);
  });

  it("leaves the proof for a daemon the app started alone", async () => {
    const { proofs, state } = adopted();
    const spawned = { ...daemon, appProof: "p".repeat(43) };
    expect(await proofs.withProof(spawned)).toEqual(spawned);
    expect(state.asked).toBe(0);
  });
});
