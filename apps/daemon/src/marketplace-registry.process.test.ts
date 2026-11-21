import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GRANT_LIFETIME_MS,
  encodeBase64url,
  grantPublicKey,
  policyBodySha256,
  signMarketGrant,
  signRegistryKeyAttestation,
} from "@ace/account-grant";
import { writeArchive, type ArchiveFile } from "@ace/marketplace";
import { folder, keySetOf, registryLink, samplePackage, testKey } from "@ace/marketplace/testing";
import { marketKey, signerToken, startMarketWorker, type MarketWorker } from "@ace/market/testing";
import type { MarketOperation, MarketResult } from "@ace/protocol/marketplace";
import type { MarketRequestPorts } from "./marketplace/options.ts";
import { fakeSpade, marketplaceHarness } from "./marketplace/test-support.ts";
import type { Membership } from "./marketplace/org-registry.ts";
import { memoryKeychain } from "./org-registry/keychain.ts";
import { registrySignerLoop } from "./org-registry/loop.ts";
import { freshSeed, makeRegistryKey, signRegistry } from "./org-registry/signer.ts";

/*
 * An organization's private registry end to end (ADR 0206 §5, §8.2), against the real market
 * Worker (Miniflare): the organization's signer on its host, with the key in that machine's
 * keychain, signs what an admin published; a device installs it only with a fresh proof that its
 * account is a member, only once the person trusts the registry's key chain, and never from a
 * chain that doesn't verify. Leaving the organization stops updates and deletes nothing. The
 * account backend is a signing key here: no WorkOS, never the real market.
 */

const org = "org_01ACME";
const owner = "user_owner";
/** This org host's id, and another host of the same organization. */
const host = "HOSTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const otherHost = "HOSTBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const backend = { id: "backend", privateKey: new Uint8Array(32).fill(5) };
const backendKeys = { keys: [grantPublicKey(backend)] };

/** A market grant the account backend mints, acting in `inOrg` with `orgRole`, for `subject`. */
function grant(
  account: string,
  options: {
    orgRole?: string;
    inOrg?: string;
    action?: string;
    iat?: number;
    subject?: string;
  } = {},
) {
  const iat = options.iat ?? Date.now();
  return signMarketGrant(
    {
      kind: options.action ? "device" : "machine",
      account,
      subject: options.subject ?? host,
      iss: "cloud.acehq.dev",
      emailVerified: true,
      authAt: iat,
      iat,
      exp: iat + GRANT_LIFETIME_MS,
      ...(options.action ? { action: options.action } : {}),
      ...(options.orgRole ? { org: options.inOrg ?? org, orgRole: options.orgRole } : {}),
    },
    backend,
  );
}

/** What a person's grant names for one request (ADR 0190). */
const intent = (method: string, path: string, body: string) =>
  `${method} ${path} ${encodeBase64url(createHash("sha256").update(body).digest())}`;

/** An owner's POST from their own session: the grant names this very body. */
const asOwner = (path: string, body: string) =>
  market.fetch(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${grant(owner, { orgRole: "owner", action: intent("POST", path, body) })}`,
    },
    body,
  });

function suit(description: string): ArchiveFile[] {
  return folder({
    "suit.json": JSON.stringify({
      format: 1,
      id: "acme-slate",
      name: "Acme slate",
      description,
      version: "1",
      base: "ace",
      light: {},
      dark: {},
    }),
    "market.json": JSON.stringify({ line: description, categories: ["calm"], keywords: ["slate"] }),
  });
}

let market: MarketWorker;
let spade: Awaited<ReturnType<typeof fakeSpade>>;
let harness: Awaited<ReturnType<typeof marketplaceHarness>>;
let start: number;
const keychain = memoryKeychain();
const signerDeps = () => ({
  keychain,
  fetch: (path: string, init: RequestInit) => market.fetch(path, init),
  now: Date.now,
  trusted: keySetOf(marketKey),
});
/** The org host's signer loop, run one round at a time. */
const loop = () =>
  registrySignerLoop({
    org: () => org,
    keychain,
    sign: (name) => signRegistry(signerDeps(), name),
    delay: () => () => {},
  });

/** An admin publishes a version to the registry; ace's maintainers release any hold; it's signed. */
async function publishVersion(type: string, name: string, version: string, files: ArchiveFile[]) {
  const published = await market.fetch(`/v1/publish/${type}/${name}/versions?version=${version}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${grant("user_admin", { orgRole: "admin" })}`,
      "content-type": "application/x-tar",
    },
    body: new Uint8Array(writeArchive(files)),
  });
  expect(published.status).toBe(201);
  // Nothing to release is fine too.
  await market.fetch(`/v1/signer/holds/${type}/${name}/${version}?registry=${org}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${signerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ decision: "approve" }),
  });
  const report = await loop().runOnce();
  expect(report?.signed).toContain(`${type}/${name}@${version}`);
}

const member = { orgRole: "member" };
/** An answer in the market's place. */
const answer = (body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
  );
/** This machine as it is at each moment: the daemon reads it live, never a snapshot. */
const asOrgHost = { keys: backendKeys, machine: { kind: "org-host" as const, org, hostId: host } };
let machineNow: Membership = asOrgHost;
const onOrgHost = () => machineNow;
const request = (operation: MarketOperation, ports: MarketRequestPorts = {}) =>
  harness.service.request(operation, ports);
const memberGrant = (subject = host) => grant("user_member", { ...member, iat: start, subject });
const asMember = (operation: MarketOperation): Promise<MarketResult> =>
  request(operation, { orgGrant: memberGrant(), membership: onOrgHost });
const errorOf = (result: MarketResult) => (result.op === "error" ? result : undefined);
const prepare = {
  op: "prepare",
  source: "market",
  type: "suit",
  name: "acme-slate",
  registry: org,
} as const;
const installOf = (id: string, hash: string): MarketOperation => ({
  op: "install",
  id,
  hash,
  choices: { bots: [], needs: {}, startRoutines: false },
});
const installed = async (name: string) => {
  const list = await request({ op: "installed" });
  return list.op === "installed" ? list.installed.find((each) => each.name === name) : undefined;
};
const chainPath = `/v1/orgs/${org}/keys`;
let firstKey = "";
/** The person's answer to the first trust question: the first key's upload digest. */
let trusted = "";
let fingerprint = "";

beforeAll(async () => {
  market = await startMarketWorker({ grantKeys: [grantPublicKey(backend)] });
  expect(
    (await asOwner(`/v1/orgs/${org}/registry`, JSON.stringify({ handle: "acme" }))).status,
  ).toBe(201);
  // The key is made in the org host's keychain; an owner publishes the upload from their app,
  // with the account backend's attestation of it.
  const made = await makeRegistryKey(signerDeps(), {
    org,
    owner,
    rotate: false,
    seed: freshSeed(),
  });
  firstKey = made.key.id;
  const attestation = signRegistryKeyAttestation(
    {
      org,
      upload_sha256: policyBodySha256(made.upload),
      account: owner,
      role: "owner",
      at: Date.now(),
    },
    backend,
  );
  const published = await asOwner(chainPath, JSON.stringify({ upload: made.upload, attestation }));
  expect(published.status).toBe(201);
  await publishVersion("suit", "acme-slate", "1.0.0", suit("Slate panels for Acme."));
  spade = await fakeSpade();
  start = Date.now();
  harness = await marketplaceHarness({ origin: market.origin, spade, clock: start });
}, 60_000);

afterAll(async () => {
  await harness?.close();
  await spade?.close();
  await market?.close();
});

/** A person's machine whose account isn't a member. */
const elsewhere = () => ({
  keys: backendKeys,
  machine: { kind: "personal" as const, account: "user_out", hostId: host },
});

describe("a package from an organization's registry", () => {
  it("installs on a member's org host once the person trusts the registry's key", async () => {
    expect(errorOf(await request(prepare, { membership: onOrgHost }))?.code).toBe("not_member");
    const asked = errorOf(await asMember(prepare));
    expect(asked?.code).toBe("registry_trust");
    expect(asked?.registryKey).toMatchObject({ org, key: firstKey, addedBy: owner, reset: false });
    trusted = asked?.registryKey?.upload ?? "";
    fingerprint = asked?.registryKey?.fingerprint ?? "";
    expect(asked?.message).toContain(fingerprint);
    const review = await asMember({ ...prepare, trustKey: trusted });
    if (review.op !== "review") throw new Error(JSON.stringify(review));
    // The install needs membership at that moment too, not only at the review.
    const install = installOf(review.review.id, review.review.hash);
    expect(errorOf(await request(install, { membership: onOrgHost }))?.code).toBe("not_member");
    expect((await asMember(install)).op).toBe("done");
    expect(await installed("acme-slate")).toMatchObject({
      version: "1.0.0",
      registry: org,
      state: "on",
    });
  });

  it("is refused on a machine whose account isn't a member, even with a member's grant copied to it", async () => {
    for (const orgGrant of [
      memberGrant(),
      grant("user_out", { orgRole: "owner", inOrg: "org_01OTHER", iat: start }),
      undefined,
    ]) {
      const refused = errorOf(
        await request(
          { ...prepare, trustKey: trusted },
          { ...(orgGrant ? { orgGrant } : {}), membership: elsewhere },
        ),
      );
      expect(refused?.code).toBe("not_member");
    }
  });

  it("is authorized for this machine only, and checked again against the chain inside the install queue", async () => {
    // A member's grant asked for another of the organization's hosts proves nothing here.
    const forOtherHost = { orgGrant: memberGrant(otherHost), membership: onOrgHost };
    expect(errorOf(await request(prepare, forOtherHost))?.code).toBe("not_member");
    const review = await asMember(prepare);
    if (review.op !== "review") throw new Error(JSON.stringify(review));
    const install = installOf(review.review.id, review.review.hash);
    expect(errorOf(await request(install, forOtherHost))?.code).toBe("not_member");
    // The chain reset after the review: the install doesn't follow it silently.
    const served = await (
      await market.fetch(chainPath, {
        headers: { authorization: `Bearer ${grant("user_member", member)}` },
      })
    ).json();
    const reset = registryLink({
      org,
      position: 0,
      key: testKey("acme-reset", 42),
      owner,
      at: Date.now(),
      grantKey: backend,
    });
    harness.hooks.respond = (url) =>
      url.endsWith(chainPath) ? answer({ ...(served as object), keys: [reset] }) : undefined;
    expect(errorOf(await asMember(install))?.code).toBe("registry_trust");
    harness.hooks.respond = undefined;
    await request({ op: "cancel", id: review.review.id });
  });

  it("is checked against this machine as it is when it installs, not when the request came", async () => {
    const review = await asMember(prepare);
    if (review.op !== "review") throw new Error(JSON.stringify(review));
    // While the chain is fetched, the host is released and becomes another organization's.
    harness.hooks.respond = (url) => {
      if (url.endsWith(chainPath))
        machineNow = { ...asOrgHost, machine: { ...asOrgHost.machine, org: "org_01OTHER" } };
      return undefined;
    };
    const refused = errorOf(await asMember(installOf(review.review.id, review.review.hash)));
    harness.hooks.respond = undefined;
    machineNow = asOrgHost;
    expect(refused?.code).toBe("not_member");
    await request({ op: "cancel", id: review.review.id });
  });

  it("is checked once more after the install's own refreshes, right before it lands", async () => {
    const review = await asMember(prepare);
    if (review.op !== "review") throw new Error(JSON.stringify(review));
    // Past the chain's check, while the withdrawn list is read, the host becomes another's.
    harness.hooks.respond = (url) => {
      if (url.endsWith("/v1/withdrawn"))
        machineNow = { ...asOrgHost, machine: { ...asOrgHost.machine, org: "org_01OTHER" } };
      return undefined;
    };
    const refused = errorOf(await asMember(installOf(review.review.id, review.review.hash)));
    harness.hooks.respond = undefined;
    machineNow = asOrgHost;
    expect(refused?.code).toBe("not_member");
    await request({ op: "cancel", id: review.review.id });
  });

  it("asks again for a reset first key that reuses the trusted key's id, showing its fingerprint", async () => {
    const served = (await (
      await market.fetch(chainPath, {
        headers: { authorization: `Bearer ${grant("user_member", member)}` },
      })
    ).json()) as { keys: unknown[] };
    // Another key under the very id the person trusted.
    const lookalike = registryLink({
      org,
      position: 0,
      key: testKey(firstKey, 77),
      owner,
      at: Date.now(),
      grantKey: backend,
    });
    harness.hooks.respond = (url) =>
      url.endsWith(chainPath) ? answer({ ...served, keys: [lookalike] }) : undefined;
    for (const answerWith of [firstKey, trusted]) {
      const asked = errorOf(await asMember({ ...prepare, trustKey: answerWith }));
      expect(asked?.code).toBe("registry_trust");
      expect(asked?.registryKey).toMatchObject({ key: firstKey, reset: true });
      expect(asked?.registryKey?.upload).not.toBe(trusted);
      expect(asked?.registryKey?.fingerprint).not.toBe(fingerprint);
      expect(asked?.message).toContain(asked?.registryKey?.fingerprint ?? "-");
    }
    harness.hooks.respond = undefined;
  });

  it("is refused from a key chain that doesn't verify, and a reset first key is asked about again", async () => {
    const served = (await (
      await market.fetch(chainPath, {
        headers: { authorization: `Bearer ${grant("user_member", member)}` },
      })
    ).json()) as { org: string; publisher: unknown; keys: unknown[] };
    // A first key attested for an admin, not an owner: the chain is broken.
    const forged = registryLink({
      org,
      position: 0,
      key: testKey("forged", 41),
      owner: "user_admin",
      role: "admin",
      at: Date.now(),
      grantKey: backend,
    });
    harness.hooks.respond = (url) =>
      url.endsWith(chainPath) ? answer({ ...served, keys: [forged] }) : undefined;
    const broken = errorOf(await asMember({ ...prepare, trustKey: "forged" }));
    expect(broken?.code).toBe("refused");
    expect(broken?.message).toMatch(/broken/);
    // A valid chain with another first key: never followed silently.
    const reset = registryLink({
      org,
      position: 0,
      key: testKey("acme-reset", 42),
      owner,
      at: Date.now(),
      grantKey: backend,
    });
    harness.hooks.respond = (url) =>
      url.endsWith(chainPath) ? answer({ ...served, keys: [reset] }) : undefined;
    expect(errorOf(await asMember(prepare))?.registryKey).toMatchObject({
      key: "acme-reset",
      reset: true,
    });
    harness.hooks.respond = undefined;
  });

  it("rolls a linked bot back only as its registry's, for a member, keeping where each version came from", async () => {
    await publishVersion("spade-bot", "flight-watcher", "1.0.0", samplePackage());
    const first = await asMember({ ...prepare, type: "spade-bot", name: "flight-watcher" });
    if (first.op !== "review") throw new Error(JSON.stringify(first));
    const choices = {
      bots: [],
      needs: {},
      startRoutines: false,
      effects: { "network:hosts:api.example-fares.com": true, send_as_person: false },
    };
    const installFirst = {
      op: "install",
      id: first.review.id,
      hash: first.review.hash,
      choices,
    } as const;
    expect((await asMember(installFirst)).op).toBe("done");
    await publishVersion("spade-bot", "flight-watcher", "2.0.0", samplePackage({ task: "kept" }));
    await asMember({ op: "registryRefresh", registry: org });
    const update = await asMember({
      op: "prepareUpdate",
      type: "spade-bot",
      name: "flight-watcher",
    });
    if (update.op !== "review") throw new Error(JSON.stringify(update));
    expect((await asMember(installOf(update.review.id, update.review.hash))).op).toBe("done");
    expect(await installed("flight-watcher")).toMatchObject({
      version: "2.0.0",
      registry: org,
      previous: { version: "1.0.0", registry: org },
    });

    const rollback = { op: "prepareRollback", type: "spade-bot", name: "flight-watcher" } as const;
    expect(errorOf(await request(rollback, { membership: onOrgHost }))?.code).toBe("not_member");
    const back = await asMember(rollback);
    if (back.op !== "review") throw new Error(JSON.stringify(back));
    expect(
      errorOf(await request(installOf(back.review.id, back.review.hash), { membership: onOrgHost }))
        ?.code,
    ).toBe("not_member");
    expect((await asMember(installOf(back.review.id, back.review.hash))).op).toBe("done");
    expect(await installed("flight-watcher")).toMatchObject({
      version: "1.0.0",
      registry: org,
      previous: { version: "2.0.0", registry: org },
    });
  });

  it("rolls back a record from before provenance was kept as its earlier version's manifest says", async () => {
    // A record an earlier build wrote: no `previous.registry`, and an earlier version that came
    // from the public market (its manifest names no registry).
    const db = new DatabaseSync(join(harness.root, "marketplace", "registry.sqlite"));
    const row = db
      .prepare("SELECT bot, data FROM bot_installs WHERE name = 'flight-watcher'")
      .get();
    const record = JSON.parse(String(row?.["data"])) as {
      previous: { registry?: string };
      previousSignedManifest: { body: { registry?: string } };
    };
    delete record.previous.registry;
    delete record.previousSignedManifest.body.registry;
    db.prepare("UPDATE bot_installs SET data = ? WHERE bot = ?").run(
      JSON.stringify(record),
      String(row?.["bot"]),
    );
    db.close();
    // A public version rolls back as the public market's: no organization's membership asked.
    const back = await request(
      { op: "prepareRollback", type: "spade-bot", name: "flight-watcher" },
      { membership: onOrgHost },
    );
    expect(back.op).toBe("review");
    if (back.op === "review") await request({ op: "cancel", id: back.review.id });
  });

  it("stops updating when the member leaves, keeps what was installed, and resumes for a member again", async () => {
    await publishVersion("suit", "acme-slate", "1.1.0", suit("Slate panels for Acme, darker."));
    await asMember({ op: "registryRefresh", registry: org });
    expect(await installed("acme-slate")).toMatchObject({ update: "1.1.0" });

    await request({ op: "registryLeft", registry: org });
    const kept = await installed("acme-slate");
    expect(kept).toMatchObject({ version: "1.0.0", state: "on", registry: org });
    expect(kept?.update).toBeUndefined();
    expect(kept?.updatesStopped).toMatch(/no longer a member/);
    // Nothing was deleted: the Suit is still in the library.
    expect((await harness.suits.list()).map((each) => each.id)).toContain("acme-slate");
    const update = { op: "prepareUpdate", type: "suit", name: "acme-slate" } as const;
    expect(errorOf(await request(update, { membership: onOrgHost }))?.code).toBe("not_member");

    await asMember({ op: "registryRefresh", registry: org });
    const resumed = await installed("acme-slate");
    expect(resumed?.updatesStopped).toBeUndefined();
    expect(resumed?.update).toBe("1.1.0");
    expect((await asMember(update)).op).toBe("review");
  });

  it("is refused when the member's grant runs out during the install's own refreshes", async () => {
    const review = await asMember(prepare);
    if (review.op !== "review") throw new Error(JSON.stringify(review));
    // The blocklist and lists take long enough that the grant sent with the install expires.
    harness.hooks.respond = (url) => {
      if (url.endsWith("/v1/withdrawn")) harness.advance(GRANT_LIFETIME_MS);
      return undefined;
    };
    const refused = errorOf(await asMember(installOf(review.review.id, review.review.hash)));
    harness.hooks.respond = undefined;
    expect(refused?.code).toBe("not_member");
  });
});
