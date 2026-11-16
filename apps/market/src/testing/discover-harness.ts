import {
  contentHash,
  hashFiles,
  signBlocklist,
  signOfficialList,
  signReviewMark,
  signVerifiedList,
  type MarketSigningKey,
} from "@ace/marketplace";
import type { SignerIo } from "@ace/marketplace/signer";
import type {
  MarketBlocklist,
  MarketOfficialList,
  MarketVerifiedList,
} from "@ace/protocol/marketplace";
import {
  asSigner,
  manifestFor,
  marketKey,
  pendingPublisher,
  publish,
  put,
  type Market,
  type Upload,
} from "./harness.ts";

/*
 * Helpers for Discover, the maintainers' routes and the signer's re-scan, through the Worker's
 * HTTP API as the signer and as readers at an address.
 */

/** The signer's I/O against the test market. */
export const signerIoOf = (market: Market): SignerIo => ({
  get: async (path) => (await market.fetch(path, { headers: asSigner })).json(),
  object: async (hash) =>
    new Uint8Array(
      await (await market.fetch(`/v1/signer/objects/${hash}`, { headers: asSigner })).arrayBuffer(),
    ),
  put: async (path, body) => {
    const response = await put(market, path, body);
    return { status: response.status, text: await response.text() };
  },
});

const pathOf = (upload: Upload) => `${upload.type}/${upload.name}/${upload.version ?? "1.0.0"}`;

/** Releases a version from its hold, as `ace market review --approve` does. */
export async function approve(market: Market, upload: Upload) {
  const answer = await put(market, `/v1/signer/holds/${pathOf(upload)}`, { decision: "approve" });
  if (answer.status !== 200) throw new Error(`approve failed: ${answer.status}`);
}

/**
 * Publishes, releases any hold, signs and optionally marks reviewed: a live entry, whatever the
 * publisher's standing.
 */
export async function publishLive(
  market: Market,
  upload: Upload & { reviewed?: boolean; byAce?: boolean },
) {
  const published = await publish(market, upload);
  if (published.status !== 201 && published.status !== 200)
    throw new Error(`publish failed: ${published.status} ${await published.text()}`);
  await approve(market, upload);
  const publisher = await pendingPublisher(market, upload.type, upload.name);
  const signed = await put(market, `/v1/signer/versions/${pathOf(upload)}`, {
    manifest: manifestFor(upload, publisher ? { publisher } : {}),
  });
  if (signed.status !== 200)
    throw new Error(`sign failed: ${signed.status} ${await signed.text()}`);
  const hash = contentHash(hashFiles(upload.files));
  if (upload.reviewed !== undefined) {
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
    const marked = await put(market, `/v1/signer/reviews/${pathOf(upload)}`, { review });
    if (marked.status !== 200) throw new Error(`review failed: ${marked.status}`);
  }
  return { hash };
}

/** A fetch of an object from one caller address. */
export const download = async (market: Market, hash: string, address: string) => {
  const response = await market.fetch(`/v1/objects/${hash}`, {
    headers: { "cf-connecting-ip": address },
  });
  await response.arrayBuffer();
  return response.status;
};

type Body<T> = Omit<T, "format" | "key">;

export const blocklistBy = (body: Body<MarketBlocklist>, key: MarketSigningKey = marketKey) =>
  signBlocklist({ format: "ace-market-blocklist", ...body, key: key.id }, key);
export const verifiedBy = (body: Body<MarketVerifiedList>, key: MarketSigningKey = marketKey) =>
  signVerifiedList({ format: "ace-market-verified", ...body, key: key.id }, key);
export const officialBy = (body: Body<MarketOfficialList>, key: MarketSigningKey = marketKey) =>
  signOfficialList({ format: "ace-market-official", ...body, key: key.id }, key);

/** Every row of every table, as text, to show what the market keeps. */
export async function everyRow(market: Market): Promise<string> {
  const { results } = await market.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\'",
    )
    .all<{ name: string }>();
  const dumps: string[] = [];
  for (const table of results) {
    if (table.name.startsWith("sqlite_") || table.name.startsWith("d1_")) continue;
    const rows = await market.db.prepare(`SELECT * FROM "${table.name}"`).all();
    dumps.push(`${table.name}: ${JSON.stringify(rows.results)}`);
  }
  return dumps.join("\n");
}
