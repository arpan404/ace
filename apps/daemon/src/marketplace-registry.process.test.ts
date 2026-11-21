import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GRANT_LIFETIME_MS,
  encodeBase64url,
  grantPublicKey,
  signMarketGrant,
} from "@ace/account-grant";
import { writeArchive, type ArchiveFile } from "@ace/marketplace";
import { folder, keySetOf, registryLink, testKey } from "@ace/marketplace/testing";
import { marketKey, signerToken, startMarketWorker, type MarketWorker } from "@ace/market/testing";
import type { MarketOperation, MarketResult } from "@ace/protocol/marketplace";
import type { MarketRequestPorts } from "./marketplace/options.ts";
import { fakeSpade, marketplaceHarness } from "./marketplace/test-support.ts";
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
const backend = { id: "backend", privateKey: new Uint8Array(32).fill(5) };
const backendKeys = { keys: [grantPublicKey(backend)] };

/** A market grant the account backend mints, acting in `inOrg` with `orgRole`. */
function grant(
  account: string,
  options: { orgRole?: string; inOrg?: string; action?: string; iat?: number } = {},
) {
  const iat = options.iat ?? Date.now();
  return signMarketGrant(
    {
      kind: options.action ? "device" : "machine",
      account,
      subject: "laptop",
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

async function publishVersion(version: string, files: ArchiveFile[]) {
  const answer = await market.fetch(`/v1/publish/suit/acme-slate/versions?version=${version}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${grant("user_admin", { orgRole: "admin" })}`,
      "content-type": "application/x-tar",
    },
    body: writeArchive(files),
  });
  expect(answer.status).toBe(201);
  // ace's maintainers release a hold the scan made; nothing to release is fine too.
  await market.fetch(`/v1/signer/holds/suit/acme-slate/${version}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${signerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ decision: "approve" }),
  });
  const report = await loop().runOnce();
  expect(report?.signed).toContain(`suit/acme-slate@${version}`);
}

const member = { orgRole: "member" };
const onOrgHost = { keys: backendKeys, machine: { kind: "org-host" as const, org } };
const request = (operation: MarketOperation, ports: MarketRequestPorts = {}) =>
  harness.service.request(operation, ports);
const asMember = (operation: MarketOperation): Promise<MarketResult> =>
  request(operation, {
    orgGrant: grant("user_member", { ...member, iat: start }),
    membership: onOrgHost,
  });
const errorOf = (result: MarketResult) => (result.op === "error" ? result : undefined);
const prepare = {
  op: "prepare",
  source: "market",
  type: "suit",
  name: "acme-slate",
  registry: org,
} as const;
let firstKey = "";

beforeAll(async () => {
  market = await startMarketWorker({ grantKeys: [grantPublicKey(backend)] });
  const created = JSON.stringify({ handle: "acme" });
  const path = `/v1/orgs/${org}/registry`;
  const opened = await market.fetch(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${grant(owner, { orgRole: "owner", action: intent("POST", path, created) })}`,
    },
    body: created,
  });
  expect(opened.status).toBe(201);
  // The key is made in the org host's keychain; an owner publishes the upload from their app.
  const made = await makeRegistryKey(signerDeps(), {
    org,
    owner,
    rotate: false,
    seed: freshSeed(),
  });
  firstKey = made.key.id;
  const keys = `/v1/orgs/${org}/keys`;
  const published = await market.fetch(keys, {
    method: "POST",
    headers: {
      authorization: `Bearer ${grant(owner, { orgRole: "owner", action: intent("POST", keys, made.upload) })}`,
    },
    body: made.upload,
  });
  expect(published.status).toBe(201);
  await publishVersion("1.0.0", suit("Slate panels for Acme."));
  spade = await fakeSpade();
  start = Date.now();
  harness = await marketplaceHarness({ origin: market.origin, spade, clock: start });
}, 60_000);

afterAll(async () => {
  await harness?.close();
  await spade?.close();
  await market?.close();
});

describe("a package from an organization's registry", () => {
  it("installs on a member's org host once the person trusts the registry's key", async () => {
    expect(errorOf(await request(prepare, { membership: onOrgHost }))?.code).toBe("not_member");
    const asked = errorOf(await asMember(prepare));
    expect(asked?.code).toBe("registry_trust");
    expect(asked?.registryKey).toMatchObject({ org, key: firstKey, addedBy: owner, reset: false });
    const review = await asMember({ ...prepare, trustKey: firstKey });
    if (review.op !== "review") throw new Error(JSON.stringify(review));
    // The install needs membership at that moment too, not only at the review.
    const install = { op: "install", id: review.review.id, hash: review.review.hash } as const;
    expect(errorOf(await request(install, { membership: onOrgHost }))?.code).toBe("not_member");
    expect((await asMember(install)).op).toBe("done");
    const installed = await request({ op: "installed" });
    expect(installed.op === "installed" && installed.installed).toEqual([
      expect.objectContaining({ name: "acme-slate", version: "1.0.0", registry: org, state: "on" }),
    ]);
  });

  it("is refused on a machine whose account isn't a member, even with a member's grant copied to it", async () => {
    const elsewhere = {
      keys: backendKeys,
      machine: { kind: "personal" as const, account: "user_out" },
    };
    for (const orgGrant of [
      grant("user_member", { ...member, iat: start }),
      grant("user_out", { orgRole: "owner", inOrg: "org_01OTHER", iat: start }),
      undefined,
    ]) {
      const refused = errorOf(
        await request(
          { ...prepare, trustKey: firstKey },
          { ...(orgGrant ? { orgGrant } : {}), membership: elsewhere },
        ),
      );
      expect(refused?.code).toBe("not_member");
    }
  });

  it("is refused from a key chain that doesn't verify, and a reset first key is asked about again", async () => {
    const chainPath = `/v1/orgs/${org}/keys`;
    const served = (await (
      await market.fetch(chainPath, {
        headers: { authorization: `Bearer ${grant("user_member", member)}` },
      })
    ).json()) as { org: string; publisher: unknown; keys: { upload: string; grant: string }[] };
    const answer = (body: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
      );
    // A first key countersigned for an admin, not an owner: the chain is broken.
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

  it("stops updating when the member leaves, keeps what was installed, and resumes for a member again", async () => {
    await publishVersion("1.1.0", suit("Slate panels for Acme, darker."));
    const refreshed = await asMember({ op: "registryRefresh", registry: org });
    expect(refreshed.op === "installed" && refreshed.installed[0]).toMatchObject({
      update: "1.1.0",
    });

    const left = await request({ op: "registryLeft", registry: org });
    const kept = left.op === "installed" ? left.installed[0] : undefined;
    expect(kept).toMatchObject({ version: "1.0.0", state: "on", registry: org });
    expect(kept?.update).toBeUndefined();
    expect(kept?.updatesStopped).toMatch(/no longer a member/);
    // Nothing was deleted: the Suit is still in the library.
    expect((await harness.suits.list()).map((each) => each.id)).toContain("acme-slate");
    const update = { op: "prepareUpdate", type: "suit", name: "acme-slate" } as const;
    expect(errorOf(await request(update, { membership: onOrgHost }))?.code).toBe("not_member");

    const back = await asMember({ op: "registryRefresh", registry: org });
    const resumed = back.op === "installed" ? back.installed[0] : undefined;
    expect(resumed?.updatesStopped).toBeUndefined();
    expect(resumed?.update).toBe("1.1.0");
    expect((await asMember(update)).op).toBe("review");
  });
});
