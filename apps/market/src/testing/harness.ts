import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import {
  GRANT_LIFETIME_MS,
  grantPublicKey,
  signCloudGrant,
  signGrant,
  signMarketGrant,
} from "@ace/account-grant";
import {
  contentHash,
  hashFiles,
  signManifest,
  signReviewMark,
  writeArchive,
  type ArchiveFile,
  type MarketSigningKey,
} from "@ace/marketplace";
import { keySetOf, testKey, testPublisher } from "@ace/marketplace/testing";
import type { MarketEntryType } from "@ace/protocol/marketplace";
import {
  catalogueBindings,
  databases,
  domainBindings,
  type DatabaseBindings,
} from "../store/databases.ts";

/*
 * The market Worker under real workerd (Miniflare) with local D1 and R2, and helpers that act
 * as a publisher and as the signer through its HTTP API.
 */

export const grantKey = { id: "acct", privateKey: new Uint8Array(32).fill(3) };
export const marketKey = testKey("market", 9);
export const signerToken = "signer-token-for-tests";

export async function startMarket() {
  const harness = createTestHarness({
    workers: [
      {
        configPath: fileURLToPath(import.meta.resolve("../../wrangler.jsonc")),
        secrets: {
          ACE_GRANT_KEYS: JSON.stringify({ keys: [grantPublicKey(grantKey)] }),
          MARKET_PUBLIC_KEYS: JSON.stringify(keySetOf(marketKey)),
          MARKET_SIGNER_TOKEN: signerToken,
        },
      },
    ],
  });
  const { url } = await harness.listen();
  const worker = harness.getWorker();
  // Every database, each from its own migration folder (ADR 0174 §16).
  for (const binding of [...Object.values(catalogueBindings), ...Object.values(domainBindings)])
    await worker.applyD1Migrations(binding);
  const fetch = (path: string, init?: Parameters<typeof worker.fetch>[1]) =>
    worker.fetch(`https://market.acehq.dev${path}`, init);
  // The bindings the Worker gets (ADR 0125: the harness's own configuration).
  const env = (await worker.getEnv()) as DatabaseBindings & { OBJECTS: R2Bucket };
  return {
    fetch,
    /** Where the Worker listens, for tools that reach it over HTTP (the `ace market` CLI). */
    url,
    /** The market's local D1 databases, for tests of the store's own rules. */
    dbs: databases(env),
    /** The market's R2, for tests that leave bytes as a request cut off part way would. */
    objects: env.OBJECTS,
    /** Runs the Worker's scheduled work, as its cron does. */
    scheduled: () => worker.scheduled({ cron: "*/15 * * * *", scheduledTime: new Date() }),
    close: () => harness.close(),
  };
}
export type Market = Awaited<ReturnType<typeof startMarket>>;

const lifetime = (iat = Date.now()) => ({ iat, exp: iat + GRANT_LIFETIME_MS });

/** A market publishing grant for `account`, as the account backend mints it. */
export const marketGrant = (account: string) =>
  signMarketGrant(
    {
      kind: "machine",
      account,
      subject: "host-a",
      iss: "cloud.acehq.dev",
      emailVerified: true,
      authAt: Date.now(),
      ...lifetime(),
    },
    grantKey,
  );
/**
 * The person's market grant for one sensitive request, `METHOD /path` (ADR 0190): what an ace app
 * gets with its own session for a withdrawal, a transfer or a handle change.
 */
export const personMarketGrant = (account: string, action: string) =>
  signMarketGrant(
    {
      kind: "device",
      account,
      subject: "phone",
      iss: "cloud.acehq.dev",
      emailVerified: true,
      authAt: Date.now(),
      action,
      ...lifetime(),
    },
    grantKey,
  );
export const relayGrant = (account: string, kind: "machine" | "device" = "machine") =>
  signGrant({ kind, account, subject: "host-a", ...lifetime() }, grantKey);
export const cloudGrant = (account: string) =>
  signCloudGrant({ kind: "machine", account, subject: "host-a", ...lifetime() }, grantKey);

export const asSigner = { authorization: `Bearer ${signerToken}` };

export interface Upload {
  type: MarketEntryType;
  name: string;
  version?: string;
  files: ArchiveFile[];
  account?: string;
  publisher?: string;
  grant?: string;
}

/** Publishes a folder as `account` (by default `acct_a`, publisher `tester`). */
export function publish(market: Market, upload: Upload) {
  const account = upload.account ?? "acct_a";
  const params = new URLSearchParams({ version: upload.version ?? "1.0.0" });
  params.set("publisher", upload.publisher ?? "tester");
  return market.fetch(`/v1/publish/${upload.type}/${upload.name}/versions?${params}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${upload.grant ?? marketGrant(account)}`,
      "content-type": "application/x-tar",
    },
    body: writeArchive(upload.files),
  });
}

/** The manifest the signer would sign for a stored version. */
export function manifestFor(
  upload: { type: MarketEntryType; name: string; version?: string; files: ArchiveFile[] },
  options: { key?: MarketSigningKey; publisher?: { id: string; name: string } | undefined } = {},
) {
  const hashed = hashFiles(upload.files);
  const key = options.key ?? marketKey;
  return signManifest(
    {
      format: "ace-market-manifest",
      type: upload.type,
      name: upload.name,
      version: upload.version ?? "1.0.0",
      publisher: options.publisher ?? testPublisher,
      hash: contentHash(hashed),
      files: hashed,
      size: hashed.reduce((sum, file) => sum + file.bytes, 0),
      published: 1_700_000_000_000,
      key: key.id,
    },
    key,
  );
}

export function put(market: Market, path: string, body: unknown) {
  return market.fetch(path, {
    method: "PUT",
    headers: { ...asSigner, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The publisher the signer sees for a pending version. */
export async function pendingPublisher(market: Market, type: string, name: string) {
  const pending = (await (
    await market.fetch("/v1/signer/pending", { headers: asSigner })
  ).json()) as {
    versions: { type: string; name: string; publisher: { id: string; name: string } }[];
  };
  return pending.versions.find((version) => version.type === type && version.name === name)
    ?.publisher;
}

/**
 * A maintainer releases a held version (ADR 0174 §9), as a new publisher's first version is held.
 * A version that isn't held is left alone.
 */
export async function approveHeld(market: Market, type: string, name: string, version = "1.0.0") {
  const response = await put(market, `/v1/signer/holds/${type}/${name}/${version}`, {
    decision: "approve",
  });
  await response.body?.cancel();
  return response.status;
}

/** Publishes, then signs, as publisher and signer together; optionally with a review mark. */
export async function publishSigned(
  market: Market,
  upload: Upload & { reviewed?: boolean; byAce?: boolean },
) {
  const published = await publish(market, upload);
  if (published.status !== 201 && published.status !== 200)
    throw new Error(`publish failed: ${published.status} ${await published.text()}`);
  const version = upload.version ?? "1.0.0";
  const path = `${upload.type}/${upload.name}/${version}`;
  // A new publisher's first version is held (ADR 0174 §9): a maintainer releases it first.
  const accepted = (await published.json()) as { held?: boolean };
  if (accepted.held) {
    const released = await put(market, `/v1/signer/holds/${path}`, { decision: "approve" });
    if (released.status !== 200) throw new Error(`release failed: ${released.status}`);
  }
  const publisher = await pendingPublisher(market, upload.type, upload.name);
  const signed = await put(market, `/v1/signer/versions/${path}`, {
    manifest: manifestFor(upload, publisher ? { publisher } : {}),
  });
  if (signed.status !== 200)
    throw new Error(`sign failed: ${signed.status} ${await signed.text()}`);
  if (upload.reviewed !== undefined) {
    const hash = contentHash(hashFiles(upload.files));
    const review = signReviewMark(
      {
        format: "ace-market-review",
        type: upload.type,
        name: upload.name,
        hash,
        reviewed: upload.reviewed,
        byAce: upload.byAce ?? false,
        at: 1_700_000_000_000,
        key: marketKey.id,
      },
      marketKey,
    );
    const marked = await put(market, `/v1/signer/reviews/${path}`, { review });
    if (marked.status !== 200) throw new Error(`review failed: ${marked.status}`);
  }
  return { hash: contentHash(hashFiles(upload.files)) };
}

/** A catalogue's local database, by entry type (ADR 0174 §16). */
export function catalogueOf(market: Market, type: string): D1Database {
  const db = market.dbs.catalogue(type);
  if (!db) throw new Error(`no catalogue for ${type}`);
  return db;
}
