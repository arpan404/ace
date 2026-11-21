import { describe, expect, it } from "vitest";
import { grantPublicKey } from "@ace/account-grant";
import type { RegistryKeyChain } from "@ace/protocol/marketplace";
import {
  chainStanding,
  registryRequestProved,
  signRegistryRequest,
  verifyRegistryChain,
  verifyRegistryManifest,
} from "./registry.ts";
import { marketPublicKey } from "./signing.ts";
import { registryLink, sampleSkill, signedVersion, testKey } from "./testing.ts";

const org = "org_01ACME";
const grantKey = { id: "acct", privateKey: new Uint8Array(32).fill(3) };
const grantKeys = { keys: [grantPublicKey(grantKey)] };
const first = testKey("acme-1", 11);
const second = testKey("acme-2", 12);
const at = 1_800_000_000_000;
const publisher = { id: "pub_acme", name: "acme" };

const link = (overrides: Partial<Parameters<typeof registryLink>[0]> = {}) =>
  registryLink({ org, position: 0, key: first, owner: "user_owner", at, grantKey, ...overrides });
const chainOf = (...keys: RegistryKeyChain["keys"]): RegistryKeyChain => ({ org, publisher, keys });
const rotated = link({ position: 1, key: second, previous: first, at: at + 1000 });

describe("a registry's key chain", () => {
  it("verifies from an owner's countersigned first key through each rotation", () => {
    const chain = verifyRegistryChain(chainOf(link(), rotated), { grantKeys });
    expect(chain.keys.map((key) => key.id)).toEqual(["acme-1", "acme-2"]);
    expect(chain.current).toEqual(marketPublicKey(second));
  });

  it.each([
    ["a first key a non-owner added", chainOf(link({ role: "admin" })), /owner/],
    [
      "a first key countersigned by an unknown backend key",
      chainOf(link({ grantKey: { id: "acct", privateKey: new Uint8Array(32).fill(4) } })),
      /countersign/,
    ],
    [
      "a first key whose grant named another upload",
      chainOf({ ...link(), grant: link({ at: at + 5 }).grant }),
      /another request/,
    ],
    [
      "a later key the key before it didn't sign",
      chainOf(link(), link({ position: 1, key: second, previous: testKey("acme-1", 99), at })),
      /key before it/,
    ],
    ["a later key standing first", chainOf(rotated), /wrong key before it|order/],
    ["another organization's key", { ...chainOf(link()), org: "org_01OTHER" }, /another registry/],
  ])("refuses %s", (_what, chain, reason) => {
    expect(() => verifyRegistryChain(chain, { grantKeys })).toThrow(reason);
  });

  it("stands as trusted when it extends the pin, and as reset or broken otherwise", () => {
    const pinned = verifyRegistryChain(chainOf(link()), { grantKeys });
    const extended = verifyRegistryChain(chainOf(link(), rotated), { grantKeys });
    const reset = verifyRegistryChain(chainOf(link({ key: second })), { grantKeys });
    expect(chainStanding(pinned, undefined)).toBe("new");
    expect(chainStanding(extended, { uploads: pinned.uploads })).toBe("trusted");
    expect(chainStanding(reset, { uploads: pinned.uploads })).toBe("reset");
    expect(chainStanding(pinned, { uploads: extended.uploads })).toBe("broken");
  });
});

describe("a registry's manifests", () => {
  const chain = verifyRegistryChain(chainOf(link()), { grantKeys });
  it("verify when one of its keys signed them for that registry", () => {
    const signed = signedVersion({
      type: "spade-skill",
      name: "triage",
      files: sampleSkill(),
      key: first,
      registry: org,
    });
    expect(verifyRegistryManifest(signed.manifest, chain).registry).toBe(org);
  });
  it("are refused when signed for no registry or another", () => {
    for (const registry of [undefined, "org_01OTHER"]) {
      const signed = signedVersion({
        type: "spade-skill",
        name: "triage",
        files: sampleSkill(),
        key: first,
        ...(registry ? { registry } : {}),
      });
      expect(() => verifyRegistryManifest(signed.manifest, chain)).toThrow(/registry/);
    }
  });
});

describe("the org signer's request proofs", () => {
  const request = { method: "GET", path: `/v1/orgs/${org}/signer/pending`, body: new Uint8Array() };
  const current = marketPublicKey(first);
  it("prove the current key's holder, within five minutes", () => {
    const header = signRegistryRequest(first, { ...request, at });
    expect(registryRequestProved(header, current, { ...request, now: at + 60_000 })).toBe(true);
    expect(registryRequestProved(header, current, { ...request, now: at + 6 * 60_000 })).toBe(
      false,
    );
  });
  it("prove nothing for another path, another key or none", () => {
    const header = signRegistryRequest(first, { ...request, at });
    expect(
      registryRequestProved(header, current, { ...request, path: "/v1/orgs/x", now: at }),
    ).toBe(false);
    expect(
      registryRequestProved(signRegistryRequest(second, { ...request, at }), current, {
        ...request,
        now: at,
      }),
    ).toBe(false);
    expect(registryRequestProved(null, current, { ...request, now: at })).toBe(false);
  });
});
