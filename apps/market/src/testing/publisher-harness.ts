import { GRANT_LIFETIME_MS, signMarketGrant } from "@ace/account-grant";
import { writeArchive, type ArchiveFile } from "@ace/marketplace";
import type { MarketEntryType } from "@ace/protocol/marketplace";
import { grantKey, manifestFor, put, type Market } from "./harness.ts";

/*
 * Acting as a publisher through the market's HTTP API (ADR 0173): grants with chosen claims,
 * profiles, drafts, the publisher's own routes, and synthetic, inert pictures.
 */

export interface GrantOptions {
  iss?: string;
  emailVerified?: boolean;
  /** When the session behind the grant signed in. */
  authAt?: number;
  /** When the grant was minted; its lifetime runs from here. */
  iat?: number;
}

export function grantFor(account: string, options: GrantOptions = {}) {
  const iat = options.iat ?? Date.now();
  return signMarketGrant(
    {
      kind: "machine",
      account,
      subject: "host-a",
      iss: options.iss ?? "cloud.acehq.dev",
      emailVerified: options.emailVerified ?? true,
      authAt: options.authAt ?? Date.now(),
      iat,
      exp: iat + GRANT_LIFETIME_MS,
    },
    grantKey,
  );
}

export const bearerOf = (account: string, options?: GrantOptions) => ({
  authorization: `Bearer ${grantFor(account, options)}`,
});

/** A request as `account` to a `/v1/me…` path; a JSON body unless it is bytes. */
export function asAccount(
  market: Market,
  account: string,
  method: string,
  path: string,
  body?: unknown,
  options?: GrantOptions,
) {
  const bytes = body instanceof Uint8Array;
  const init: RequestInit = {
    method,
    headers: {
      ...bearerOf(account, options),
      ...(body === undefined
        ? {}
        : { "content-type": bytes ? "application/octet-stream" : "application/json" }),
    },
  };
  if (body !== undefined) init.body = bytes ? body : JSON.stringify(body);
  return market.fetch(path, init as Parameters<Market["fetch"]>[1]);
}

export async function jsonOf<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** Makes `account`'s profile with `handle`. */
export async function makeProfile(market: Market, account: string, handle: string) {
  const response = await asAccount(market, account, "POST", "/v1/me/profile", {
    handle,
    displayName: `The ${handle}`,
  });
  if (response.status !== 201)
    throw new Error(`profile failed: ${response.status} ${await response.text()}`);
  return jsonOf<{ id: string; handle: string }>(response);
}

/** Makes the publisher an established one: old enough, with three live versions (ADR 0173 §9). */
export async function establish(market: Market, handle: string) {
  await market.db
    .prepare("UPDATE publishers SET created = 0, live_versions = 3 WHERE name = ?1")
    .bind(handle)
    .run();
}

/** A profile for `account`, established, so its versions wait only for the signer. */
export async function establishedPublisher(market: Market, account: string, handle: string) {
  const profile = await makeProfile(market, account, handle);
  await establish(market, handle);
  return profile;
}

export interface DraftUpload {
  type: MarketEntryType;
  name: string;
  version?: string;
  files: ArchiveFile[];
}

export function createDraft(market: Market, account: string, upload: DraftUpload) {
  const params = new URLSearchParams({
    type: upload.type,
    name: upload.name,
    version: upload.version ?? "1.0.0",
  });
  return asAccount(market, account, "POST", `/v1/me/drafts?${params}`, writeArchive(upload.files));
}

/** Uploads a draft and publishes it; answers the publish response. */
export async function draftAndPublish(market: Market, account: string, upload: DraftUpload) {
  const created = await createDraft(market, account, upload);
  if (created.status !== 201)
    throw new Error(`draft failed: ${created.status} ${await created.text()}`);
  const draft = await jsonOf<{ id: string }>(created);
  return asAccount(market, account, "POST", `/v1/me/drafts/${draft.id}/publish`);
}

/** Signs a stored version as the signer does, for `publisher`. */
export async function sign(
  market: Market,
  upload: DraftUpload,
  publisher: { id: string; name: string },
) {
  const version = upload.version ?? "1.0.0";
  const response = await put(
    market,
    `/v1/signer/versions/${upload.type}/${upload.name}/${version}`,
    { manifest: manifestFor({ ...upload, version }, { publisher }) },
  );
  if (response.status !== 200)
    throw new Error(`sign failed: ${response.status} ${await response.text()}`);
}

/** Publishes through a draft and signs: a live version of an established publisher's entry. */
export async function liveVersion(
  market: Market,
  account: string,
  publisher: { id: string; handle: string },
  upload: DraftUpload,
) {
  const published = await draftAndPublish(market, account, upload);
  if (published.status !== 201)
    throw new Error(`publish failed: ${published.status} ${await published.text()}`);
  await sign(market, upload, { id: publisher.id, name: publisher.handle });
}

export const indexNames = async (market: Market) => {
  const body = await jsonOf<{ entries: { type: string; name: string }[] }>(
    await market.fetch("/v1/index"),
  );
  return body.entries.map((entry) => `${entry.type}/${entry.name}`);
};

export const searchNames = async (market: Market, query: string) => {
  const body = await jsonOf<{ entries: { type: string; name: string }[] }>(
    await market.fetch(`/v1/search?q=${encodeURIComponent(query)}`),
  );
  return body.entries.map((entry) => `${entry.type}/${entry.name}`);
};

/* ---------------------------------------------------------------- inert pictures */

function crc(bytes: Uint8Array): number {
  let c = ~0;
  for (const byte of bytes) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return ~c >>> 0;
}
const be32 = (value: number) => Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value);
function joined(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
export function pngChunk(type: string, data: Uint8Array) {
  const body = joined(new TextEncoder().encode(type), data);
  return joined(be32(data.length), body, be32(crc(body)));
}

/** A PNG of `width` by `height` with placeholder image data and any extra chunks. */
export function testPng(width: number, height: number, ...extra: Uint8Array[]) {
  return joined(
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk("IHDR", joined(be32(width), be32(height), Uint8Array.of(8, 6, 0, 0, 0))),
    ...extra,
    pngChunk("IDAT", Uint8Array.of(0x78, 0x9c, 1, 2, 3)),
    pngChunk("IEND", new Uint8Array()),
  );
}
