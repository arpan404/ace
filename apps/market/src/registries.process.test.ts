import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarketSigningKey } from "@ace/marketplace";
import {
  readRegistryKeyUpload,
  registryProofHeader,
  signRegistryRequest,
} from "@ace/marketplace/registry";
import { writeArchive } from "@ace/marketplace";
import { registrySignerIo, type RegistryFetch } from "@ace/marketplace/registry-io";
import { signPending } from "@ace/marketplace/signer";
import { keySetOf, registryLink, sampleSkill, sampleSuit, testKey } from "@ace/marketplace/testing";
import { MarketScanContextBody, VersionBody } from "@ace/protocol/marketplace";
import {
  asSigner,
  catalogueOf,
  grantKey,
  manifestFor,
  marketKey,
  publish,
  put,
  startMarket,
  type Market,
} from "./testing/harness.ts";
import { grantFor, intentOf } from "./testing/publisher-harness.ts";
import { addKey as storeKey, chainState } from "./store/registries.ts";

/*
 * An organization's private registry on the real Worker (ADR 0206 §5, §8.2): its entries answer
 * only to its members, under the organization's own paths and names; publishing needs the
 * registry role; ace's scan holds its versions as any other; its own key, never ace's, signs
 * them; and nothing it serves or keeps opens anything else.
 */

const acme = "org_01ACME";
const other = "org_01OTHER";
const owner = "user_owner";
const acmeKey = testKey("acme-1", 21);
const otherKey = testKey("other-1", 23);

let market: Market;
const as = (account: string, orgRole?: string, inOrg = acme) =>
  `Bearer ${grantFor(account, orgRole === undefined ? {} : { org: inOrg, orgRole })}`;
const read = (path: string, authorization?: string) =>
  market.fetch(path, authorization ? { headers: { authorization } } : {});
const member = () => as("user_member", "member");

/** An owner's request from their own session: the grant names this very body (ADR 0190). */
async function asOwner(
  org: string,
  path: string,
  body: string,
  account = owner,
  orgRole = "owner",
) {
  const action = await intentOf("POST", path, new TextEncoder().encode(body));
  const grant = grantFor(account, { action, org, orgRole });
  const answer = await market.fetch(path, {
    method: "POST",
    headers: { authorization: `Bearer ${grant}` },
    body,
  });
  return { answer, grant };
}

/** Publishes a key with the backend's attestation, as an owner's app does. */
const addKey = (org: string, link: { upload: string; attestation: string }) =>
  asOwner(org, `/v1/orgs/${org}/keys`, JSON.stringify(link));

const linkFor = (
  org: string,
  key: MarketSigningKey,
  extra: Partial<Parameters<typeof registryLink>[0]> = {},
) => registryLink({ org, position: 0, key, owner, at: Date.now(), grantKey, ...extra });

/** The Worker reached as the org signer reaches the market: a standard fetch's answer. */
const viaWorker: RegistryFetch = async (path, init) => {
  const answer = await market.fetch(path, init);
  return new Response(await answer.arrayBuffer(), { status: answer.status });
};
const signerIo = (org: string, key: MarketSigningKey) =>
  registrySignerIo({ org, key, now: Date.now, fetch: viaWorker });

/** The org signer's run, as `ace org registry sign` makes it on the organization's machine. */
const orgSign = (org = acme, key = acmeKey) =>
  signPending(signerIo(org, key), key, Date.now, keySetOf(marketKey), {
    registry: { org, keys: keySetOf(key) },
  });

/** ace's maintainers release a registry's held version, named by its organization. */
const release = (org: string, name: string) =>
  put(market, `/v1/signer/holds/spade-skill/${name}/1.0.0?registry=${org}`, {
    decision: "approve",
  });

/** A skill ace's scan warns about (it reads a `.env`), so its version is held for a maintainer. */
const warned = (name: string) =>
  sampleSkill(name, { "scripts/setup.sh": "#!/bin/sh\nsource ./.env\necho ready\n" });

async function openRegistry(org: string, handle: string, key: MarketSigningKey) {
  const { answer } = await asOwner(org, `/v1/orgs/${org}/registry`, JSON.stringify({ handle }));
  expect(answer.status).toBe(201);
  expect((await addKey(org, linkFor(org, key))).answer.status).toBe(201);
}

/** Publishes `name` as the organization's admin, releases ace's hold, and signs it. */
async function publishToRegistry(name: string, org = acme, key = acmeKey) {
  const published = await publish(market, {
    type: "spade-skill",
    name,
    files: sampleSkill(name),
    grant: grantFor("user_admin", { org, orgRole: "admin" }),
  });
  expect(published.status).toBe(201);
  // The registry's publisher is new: its first versions are held for ace's maintainers.
  expect((await release(org, name)).status).toBe(200);
  expect((await orgSign(org, key)).signed).toContain(`spade-skill/${name}@1.0.0`);
}

const versionOf = async (org: string, name: string, caller: string) =>
  VersionBody.parse(
    await (await read(`/v1/orgs/${org}/entries/spade-skill/${name}/1.0.0`, caller)).json(),
  ).manifest.body as { hash: string; name: string; registry: string; key: string };

beforeAll(async () => {
  market = await startMarket();
  await openRegistry(acme, "acme", acmeKey);
  await openRegistry(other, "other-org", otherKey);
  await publishToRegistry("acme-triage");
  await publishToRegistry("other-secret", other, otherKey);
});
afterAll(() => market.close());

describe("an organization's entries", () => {
  const paths = [
    `/v1/orgs/${acme}/entries/spade-skill/acme-triage`,
    `/v1/orgs/${acme}/entries/spade-skill/acme-triage/1.0.0`,
    `/v1/orgs/${acme}/keys`,
    `/v1/orgs/${acme}/entries`,
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

  it("answer a member under the organization, never for a shared cache, signed by its key", async () => {
    for (const path of paths) {
      const answer = await read(path, member());
      expect(answer.status, path).toBe(200);
      expect(answer.headers.get("cache-control")).toBe("private, no-store");
      await answer.body?.cancel();
    }
    const manifest = await versionOf(acme, "acme-triage", member());
    expect(manifest).toMatchObject({ name: "acme-triage", registry: acme, key: "acme-1" });
    const archive = `/v1/orgs/${acme}/objects/${manifest.hash}`;
    expect((await read(archive)).status).toBe(404);
    expect((await read(archive, as("user_out", "owner", other))).status).toBe(404);
    expect((await read(archive, member())).status).toBe(200);
  });

  it("are never reached by the public market's paths, not even by a member", async () => {
    const { hash } = await versionOf(acme, "acme-triage", member());
    for (const path of [
      "/v1/entries/spade-skill/acme-triage",
      "/v1/entries/spade-skill/acme-triage/1.0.0",
      `/v1/objects/${hash}`,
    ])
      expect((await read(path, member())).status, path).toBe(404);
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

describe("a registry's names", () => {
  it("are its own: a public publisher and another organization take the same name, and nothing says it's taken", async () => {
    const asPublic = await publish(market, {
      type: "spade-skill",
      name: "acme-triage",
      files: sampleSkill("acme-triage"),
      account: "acct_public",
      publisher: "someone",
    });
    expect(asPublic.status).toBe(201);
    const asOther = await publish(market, {
      type: "spade-skill",
      name: "acme-triage",
      files: sampleSkill("acme-triage"),
      grant: grantFor("user_other_admin", { org: other, orgRole: "admin" }),
    });
    expect(asOther.status).toBe(201);
    // The organization's own entry is untouched: its version, signed by its own key.
    expect(await versionOf(acme, "acme-triage", member())).toMatchObject({ registry: acme });
  });
});

const intentPath = (version: string) =>
  `/v1/publish/spade-skill/intent-skill/versions?version=${version}`;

const stamp = async () => ((await (await read("/v1/index")).json()) as { stamp: number }).stamp;

describe("publishing to the registry", () => {
  it("with a person's grant publishes only the version that grant names", async () => {
    const archive = writeArchive(sampleSkill("intent-skill"));
    const sent = async (version: string, named: string) =>
      market.fetch(intentPath(version), {
        method: "POST",
        headers: {
          authorization: `Bearer ${grantFor("user_admin", {
            action: await intentOf("POST", intentPath(named), archive),
            org: acme,
            orgRole: "admin",
          })}`,
          "content-type": "application/x-tar",
        },
        body: archive,
      });
    expect((await sent("2.0.0", "1.0.0")).status).toBe(401);
    expect((await sent("1.0.0", "1.0.0")).status).toBe(201);
  });

  it("moves nothing on the public index's cursor", async () => {
    const before = await stamp();
    await publishToRegistry("quiet-skill");
    expect(await stamp()).toBe(before);
  });

  it("moves nothing on the public index's cursor in a catalogue it first publishes to, nor when its publisher syncs", async () => {
    // No Suit catalogue holds a copy of the registry's publisher yet: this publish makes it.
    const suits = catalogueOf(market, "suit");
    const copies = async () =>
      (await suits.prepare("SELECT COUNT(*) AS n FROM publisher_copies").first<{ n: number }>())
        ?.n ?? 0;
    expect(await copies()).toBe(0);
    const before = await stamp();
    const published = await publish(market, {
      type: "suit",
      name: "acme-dusk",
      files: sampleSuit("acme-dusk"),
      grant: grantFor("user_admin", { org: acme, orgRole: "admin" }),
    });
    expect(published.status).toBe(201);
    expect(await copies()).toBe(1);
    await put(market, `/v1/signer/holds/suit/acme-dusk/1.0.0?registry=${acme}`, {
      decision: "approve",
    });
    expect((await orgSign()).signed).toContain("suit/acme-dusk@1.0.0");
    expect(await stamp()).toBe(before);
    // The publishers' sync carries a change of the registry's publisher to every catalogue.
    await market.dbs.publishers
      .prepare("UPDATE publishers SET revision = revision + 1 WHERE account = ?1")
      .bind(acme)
      .run();
    await market.scheduled();
    expect(await stamp()).toBe(before);
  });

  it("needs the registry:publish role; a member without it is refused", async () => {
    const refused = await publish(market, {
      type: "spade-skill",
      name: "member-skill",
      files: sampleSkill("member-skill"),
      grant: grantFor("user_member", { org: acme, orgRole: "member" }),
    });
    expect(refused.status).toBe(403);
  });

  it("is refused for an organization without a registry", async () => {
    const answer = await publish(market, {
      type: "spade-skill",
      name: "nowhere-skill",
      files: sampleSkill("nowhere-skill"),
      grant: grantFor("user_admin", { org: "org_01NONE", orgRole: "owner" }),
    });
    expect(answer.status).toBe(404);
  });

  it("goes through ace's scan, whose hold the org signer can't release, and ace's signer never signs it", async () => {
    const published = await publish(market, {
      type: "spade-skill",
      name: "held-skill",
      files: warned("held-skill"),
      grant: grantFor("user_admin", { org: acme, orgRole: "admin" }),
    });
    expect(published.status).toBe(201);
    expect(((await published.json()) as { held: boolean }).held).toBe(true);
    expect((await orgSign()).signed).not.toContain("spade-skill/held-skill@1.0.0");
    const io = signerIo(acme, acmeKey);
    const approve = { decision: "approve" };
    expect((await io.put("/v1/signer/holds/spade-skill/held-skill/1.0.0", approve)).status).toBe(
      403,
    );
    // ace's maintainers see it in their queue, by its organization, and release it there.
    const queue = (await (
      await market.fetch("/v1/signer/queue", { headers: asSigner })
    ).json()) as {
      held: { name: string; registry?: string }[];
    };
    expect(queue.held).toContainEqual(
      expect.objectContaining({ name: "held-skill", registry: acme }),
    );
    expect((await release(acme, "held-skill")).status).toBe(200);
    const pending = (await (
      await market.fetch("/v1/signer/pending", { headers: asSigner })
    ).json()) as { versions: { name: string }[] };
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

const proved = (path: string) =>
  market.fetch(path, {
    headers: {
      [registryProofHeader]: signRegistryRequest(acmeKey, {
        method: "GET",
        path,
        at: Date.now(),
      }),
    },
  });

const names = (body: unknown) =>
  MarketScanContextBody.parse(body).entries.map((entry) => entry.name);

describe("what signers see", () => {
  it("a registry's signer compares with the public market and its own registry, never another organization's", async () => {
    const seen = names(await signerIo(acme, acmeKey).get("/v1/signer/scan-context"));
    expect(seen).toContain("acme-triage");
    expect(seen).not.toContain("other-secret");
  });

  it("counts only the publishers and versions a signer may compare with", async () => {
    const context = MarketScanContextBody.parse(
      await signerIo(acme, acmeKey).get("/v1/signer/scan-context"),
    );
    expect(context.newPublishers).toContain("acme");
    expect(context.newPublishers).not.toContain("other-org");
    const ace = MarketScanContextBody.parse(
      await (await market.fetch("/v1/signer/scan-context", { headers: asSigner })).json(),
    );
    expect(ace.newPublishers).not.toContain("acme");
    expect(ace.newPublishers).not.toContain("other-org");
  });

  it("a signer's proof opens no member route; the signer reads under its own", async () => {
    for (const path of [
      `/v1/orgs/${acme}/entries/spade-skill/acme-triage`,
      `/v1/orgs/${acme}/entries/spade-skill/acme-triage/1.0.0`,
      `/v1/orgs/${acme}/keys`,
      `/v1/orgs/${acme}/entries`,
    ])
      expect((await proved(path)).status, path).toBe(404);
    for (const path of [
      `/v1/orgs/${acme}/signer/entries/spade-skill/acme-triage/1.0.0`,
      `/v1/orgs/${acme}/signer/keys`,
    ])
      expect((await proved(path)).status, path).toBe(200);
  });

  it("ace's signer reads no registry's entries, bytes or withdrawals", async () => {
    const context = await market.fetch("/v1/signer/scan-context", { headers: asSigner });
    expect(names(await context.json())).not.toContain("other-secret");
    const { hash } = await versionOf(other, "other-secret", as("user_o", "member", other));
    const bytes = await market.fetch(`/v1/signer/objects/${hash}`, { headers: asSigner });
    expect(bytes.status).toBe(404);
    // A withdrawal waiting on a registry's row never reaches ace's list.
    await catalogueOf(market, "spade-skill")
      .prepare(
        `INSERT INTO pending_withdrawals (type, name, version, hash, reason, at)
          VALUES ('spade-skill', ?1, '1.0.0', ?2, 'gone', 1)`,
      )
      .bind(`other-secret@${other}`, hash)
      .run();
    const pending = (await (
      await market.fetch("/v1/signer/pending", { headers: asSigner })
    ).json()) as { withdrawals: { name: string }[] };
    expect(pending.withdrawals).toEqual([]);
  });
});

describe("the registry's key chain", () => {
  it("opens nothing: what a member reads of it, and an owner's grant for adding a key, publish nothing", async () => {
    const chain = (await (await read(`/v1/orgs/${acme}/keys`, member())).json()) as {
      keys: { upload: string; attestation: string }[];
    };
    // The owner's own request grant, captured on the way, is good for that one request alone.
    const { grant } = await addKey(acme, linkFor(acme, testKey("acme-y", 32)));
    for (const token of [...chain.keys.flatMap((link) => [link.upload, link.attestation]), grant]) {
      const answer = await publish(market, {
        type: "spade-skill",
        name: "replayed-skill",
        files: sampleSkill("replayed-skill"),
        grant: token,
      });
      expect(answer.status).toBe(401);
    }
  });

  it("takes a first key only from an owner, with the backend's attestation of an owner", async () => {
    const link = JSON.stringify(linkFor(acme, testKey("acme-x", 31)));
    const asAdmin = await asOwner(acme, `/v1/orgs/${acme}/keys`, link, "user_admin", "admin");
    expect(asAdmin.answer.status).toBe(403);
    const attestedForAdmin = linkFor(acme, testKey("acme-z", 33), { role: "admin" });
    expect((await addKey(acme, attestedForAdmin)).answer.status).toBe(422);
  });

  it("rotates only with the key before's signature, and then only the new key signs", async () => {
    // A fresh first key starts the chain again (a reset), then rotates.
    const first = testKey("acme-3", 24);
    expect((await addKey(acme, linkFor(acme, first))).answer.status).toBe(201);
    const next = testKey("acme-4", 25);
    const forged = linkFor(acme, next, { position: 1, previous: testKey("acme-3", 99) });
    expect((await addKey(acme, forged)).answer.status).toBe(422);
    const rotation = linkFor(acme, next, { position: 1, previous: first });
    expect((await addKey(acme, rotation)).answer.status).toBe(201);
    const path = `/v1/orgs/${acme}/signer/pending`;
    const old = signRegistryRequest(first, { method: "GET", path, at: Date.now() });
    expect((await market.fetch(path, { headers: { [registryProofHeader]: old } })).status).toBe(
      401,
    );
    const fresh = signRegistryRequest(next, { method: "GET", path, at: Date.now() });
    expect((await market.fetch(path, { headers: { [registryProofHeader]: fresh } })).status).toBe(
      200,
    );
    const chain = (await (await read(`/v1/orgs/${acme}/keys`, member())).json()) as {
      keys: unknown[];
    };
    expect(chain.keys).toHaveLength(2);
  });

  it("adds a key only to the chain revision it verified, after the exact key it verified", async () => {
    const orgs = market.dbs.orgs;
    if (!orgs) throw new Error("no registries database");
    const first = testKey("race-1", 51);
    expect((await addKey(acme, linkFor(acme, first))).answer.status).toBe(201);
    // A rotation verified against this chain, its write not landed yet...
    const verified = await chainState(orgs, acme);
    const rotation = linkFor(acme, testKey("race-2", 52), { position: 1, previous: first });
    const { statement } = readRegistryKeyUpload(rotation.upload);
    // ...when a reset lands, with a new first key that reuses the same key id.
    expect((await addKey(acme, linkFor(acme, testKey("race-1", 53)))).answer.status).toBe(201);
    const landed = await storeKey(orgs, {
      org: acme,
      position: 1,
      keyId: statement.key,
      publicKey: statement.publicKey,
      upload: rotation.upload,
      attestation: rotation.attestation,
      addedBy: owner,
      at: statement.at,
      revision: verified.revision,
      previousUpload: verified.keys[0]?.link.upload,
      writer: "race-writer",
    });
    expect(landed).toBe(false);
    const after = await chainState(orgs, acme);
    expect(after.keys.map((key) => key.publicKey)).toEqual([
      readRegistryKeyUpload(after.keys[0]?.link.upload ?? "").statement.publicKey,
    ]);
    expect(after.keys).toHaveLength(1);
  });
});
