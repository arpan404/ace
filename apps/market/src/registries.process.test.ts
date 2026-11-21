import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { marketPublicKey } from "@ace/marketplace";
import { registryProofHeader, signRegistryRequest } from "@ace/marketplace/registry";
import { registrySignerIo } from "@ace/marketplace/registry-io";
import { signPending } from "@ace/marketplace/signer";
import { keySetOf, registryLink, sampleSkill, testKey } from "@ace/marketplace/testing";
import { VersionBody } from "@ace/protocol/marketplace";
import { approve } from "./testing/discover-harness.ts";
import {
  asSigner,
  grantKey,
  manifestFor,
  marketKey,
  publish,
  put,
  startMarket,
  type Market,
} from "./testing/harness.ts";
import { grantFor, intentOf } from "./testing/publisher-harness.ts";

/*
 * An organization's private registry on the real Worker (ADR 0206 §5, §8.2): its entries answer
 * only to its members, publishing needs the registry role, ace's scan holds its versions as any
 * other, and its own key, never ace's, signs them.
 */

const org = "org_01ACME";
const other = "org_01OTHER";
const owner = "user_owner";
const acmeKey = testKey("acme-1", 21);

let market: Market;
const as = (account: string, orgRole?: string, inOrg = org) =>
  `Bearer ${grantFor(account, orgRole === undefined ? {} : { org: inOrg, orgRole })}`;
const read = (path: string, authorization?: string) =>
  market.fetch(path, authorization ? { headers: { authorization } } : {});

/** An owner's request from their own session: the grant names this very body (ADR 0190). */
async function asOwner(path: string, body: string, account = owner, orgRole = "owner") {
  const action = await intentOf("POST", path, new TextEncoder().encode(body));
  return market.fetch(path, {
    method: "POST",
    headers: { authorization: `Bearer ${grantFor(account, { action, org, orgRole })}` },
    body,
  });
}

/** Publishes the first key, as `ace org registry key` does through an owner's app. */
async function addKey(link: { upload: string; grant: string }) {
  return market.fetch(`/v1/orgs/${org}/keys`, {
    method: "POST",
    headers: { authorization: `Bearer ${link.grant}` },
    body: link.upload,
  });
}

const firstLink = (key = acmeKey) =>
  registryLink({ org, position: 0, key, owner, at: Date.now(), grantKey });

/** The org signer's run, as `ace org registry sign` makes it on the organization's machine. */
const orgSign = (key = acmeKey) =>
  signPending(
    registrySignerIo({ org, key, now: Date.now, fetch: (path, init) => market.fetch(path, init) }),
    key,
    Date.now,
    keySetOf(marketKey),
    { registry: { org, keys: keySetOf(key) } },
  );

/** Publishes `name` as the organization's admin, releases ace's hold, and signs it. */
async function publishToRegistry(name: string) {
  const published = await publish(market, {
    type: "spade-skill",
    name,
    files: sampleSkill(name),
    grant: grantFor("user_admin", { org, orgRole: "admin" }),
  });
  expect(published.status).toBe(201);
  // The registry's publisher is new: its first version is held for ace's maintainers.
  await approve(market, { type: "spade-skill", name, files: [] });
  expect((await orgSign()).signed).toContain(`spade-skill/${name}@1.0.0`);
}

beforeAll(async () => {
  market = await startMarket();
  const path = `/v1/orgs/${org}/registry`;
  expect((await asOwner(path, JSON.stringify({ handle: "acme" }))).status).toBe(201);
  expect((await addKey(firstLink())).status).toBe(201);
  await publishToRegistry("acme-triage");
});
afterAll(() => market.close());

describe("an organization's entries", () => {
  const paths = [
    "/v1/entries/spade-skill/acme-triage",
    "/v1/entries/spade-skill/acme-triage/1.0.0",
    `/v1/orgs/${org}/keys`,
    `/v1/orgs/${org}/entries`,
  ];

  it("answer non-members and other organizations' members as if they didn't exist", async () => {
    const nothing = await (await read("/v1/entries/spade-skill/no-such-entry")).json();
    for (const path of paths)
      for (const caller of [undefined, as("user_out"), as("user_out", "owner", other)]) {
        const answer = await read(path, caller);
        expect(answer.status, `${path} ${caller ? "with a grant" : "anonymous"}`).toBe(404);
        expect(await answer.json()).toEqual(nothing);
      }
  });

  it("answer a member, never for a shared cache, and the archive verifies with the org's key", async () => {
    const member = as("user_member", "member");
    for (const path of paths) {
      const answer = await read(path, member);
      expect(answer.status, path).toBe(200);
      expect(answer.headers.get("cache-control")).toBe("private, no-store");
      await answer.body?.cancel();
    }
    const body = VersionBody.parse(
      await (await read("/v1/entries/spade-skill/acme-triage/1.0.0", member)).json(),
    );
    const manifest = body.manifest.body as { hash: string; registry: string; key: string };
    expect(manifest).toMatchObject({ registry: org, key: "acme-1" });
    expect((await read(`/v1/objects/${manifest.hash}`)).status).toBe(404);
    expect(
      (await read(`/v1/objects/${manifest.hash}`, as("user_out", "owner", other))).status,
    ).toBe(404);
    expect((await read(`/v1/objects/${manifest.hash}`, member)).status).toBe(200);
  });

  it("never appear in the index, search or Featured", async () => {
    const index = (await (await read("/v1/index")).json()) as { entries: { name: string }[] };
    const search = (await (await read("/v1/search?q=triage")).json()) as {
      entries: { name: string }[];
    };
    expect(index.entries.map((entry) => entry.name)).not.toContain("acme-triage");
    expect(search.entries.map((entry) => entry.name)).not.toContain("acme-triage");
    const featured = await put(market, "/v1/signer/featured", {
      entries: [{ type: "spade-skill", name: "acme-triage" }],
    });
    expect(featured.status).toBe(422);
  });
});

/** A skill ace's scan warns about (it reads a `.env`), so its version is held for a maintainer. */
const warned = (name: string) =>
  sampleSkill(name, { "scripts/setup.sh": "#!/bin/sh\nsource ./.env\necho ready\n" });

describe("publishing to the registry", () => {
  it("needs the registry:publish role; a member without it is refused", async () => {
    const refused = await publish(market, {
      type: "spade-skill",
      name: "member-skill",
      files: sampleSkill("member-skill"),
      grant: grantFor("user_member", { org, orgRole: "member" }),
    });
    expect(refused.status).toBe(403);
    expect(
      (await read("/v1/entries/spade-skill/member-skill", as("user_member", "member"))).status,
    ).toBe(404);
  });

  it("is refused for an organization without a registry", async () => {
    const answer = await publish(market, {
      type: "spade-skill",
      name: "other-skill",
      files: sampleSkill("other-skill"),
      grant: grantFor("user_admin", { org: other, orgRole: "owner" }),
    });
    expect(answer.status).toBe(404);
  });

  it("goes through ace's scan, whose hold the org signer can't release, and ace's signer never signs it", async () => {
    const published = await publish(market, {
      type: "spade-skill",
      name: "held-skill",
      files: warned("held-skill"),
      grant: grantFor("user_admin", { org, orgRole: "admin" }),
    });
    expect(published.status).toBe(201);
    expect(((await published.json()) as { held: boolean }).held).toBe(true);
    const report = await orgSign();
    expect(report.signed).not.toContain("spade-skill/held-skill@1.0.0");
    const io = registrySignerIo({ org, key: acmeKey, now: Date.now, fetch: market.fetch });
    expect(
      (await io.put("/v1/signer/holds/spade-skill/held-skill/1.0.0", { decision: "approve" }))
        .status,
    ).toBe(403);
    // Released by ace's maintainers, it waits for the registry's signer, not ace's.
    await approve(market, { type: "spade-skill", name: "held-skill", files: [] });
    const pending = (await (
      await market.fetch("/v1/signer/pending", { headers: asSigner })
    ).json()) as {
      versions: { name: string }[];
    };
    expect(pending.versions.map((version) => version.name)).not.toContain("held-skill");
    const marketSigned = await put(market, "/v1/signer/versions/spade-skill/held-skill/1.0.0", {
      manifest: manifestFor({
        type: "spade-skill",
        name: "held-skill",
        files: warned("held-skill"),
      }),
    });
    expect(marketSigned.status).toBe(404);
    expect((await orgSign()).signed).toContain("spade-skill/held-skill@1.0.0");
  });
});

describe("the registry's key chain", () => {
  it("takes a first key only from an owner, countersigned for that very upload", async () => {
    const link = firstLink(testKey("acme-x", 31));
    const asAdmin = await asOwner(`/v1/orgs/${org}/keys`, link.upload, "user_admin", "admin");
    expect(asAdmin.status).toBe(403);
    const chain = (await (
      await read(`/v1/orgs/${org}/keys`, as("user_member", "member"))
    ).json()) as {
      keys: unknown[];
    };
    expect(chain.keys).toHaveLength(1);
  });

  it("rotates only with the key before's signature, and then only the new key signs", async () => {
    const next = testKey("acme-2", 22);
    const forged = registryLink({
      org,
      position: 1,
      key: next,
      previous: testKey("acme-1", 99),
      owner,
      at: Date.now(),
      grantKey,
    });
    expect((await addKey(forged)).status).toBe(422);
    const rotation = registryLink({
      org,
      position: 1,
      key: next,
      previous: acmeKey,
      owner,
      at: Date.now(),
      grantKey,
    });
    expect((await addKey(rotation)).status).toBe(201);
    const path = `/v1/orgs/${org}/signer/pending`;
    const old = signRegistryRequest(acmeKey, { method: "GET", path, at: Date.now() });
    expect((await market.fetch(path, { headers: { [registryProofHeader]: old } })).status).toBe(
      401,
    );
    const fresh = signRegistryRequest(next, { method: "GET", path, at: Date.now() });
    expect((await market.fetch(path, { headers: { [registryProofHeader]: fresh } })).status).toBe(
      200,
    );
    const chain = (await (
      await read(`/v1/orgs/${org}/keys`, as("user_member", "member"))
    ).json()) as {
      keys: unknown[];
    };
    expect(chain.keys).toHaveLength(2);
    expect(marketPublicKey(next).id).toBe("acme-2");
  });
});
