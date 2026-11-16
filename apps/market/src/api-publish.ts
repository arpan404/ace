import { GrantError, verifyMarketGrant, type MarketGrantClaims } from "@ace/account-grant";
import { maxArchiveBytes, writeArchive, WithdrawRequest } from "@ace/marketplace";
import { checkArchive } from "@ace/marketplace/checks";
import {
  MarketPublisherName,
  MarketVersion,
  type MarketPublisher,
} from "@ace/protocol/marketplace";
import { objectKey, type Context } from "./context.ts";
import { bearer, failure, json, readCapped, readJson, refused } from "./http.ts";
import type { EntryKey, VersionKey } from "./routes.ts";
import {
  addWithdrawal,
  claimPublisher,
  nameTaken,
  ownerOf,
  publisherOf,
  storePending,
  storedVersion,
} from "./store/publish.ts";

/*
 * Publishing (ADR 0168 §7; the contract is in @ace/marketplace's service-wire.ts). A market
 * grant names the account; its first publish reserves a publisher name; an entry belongs to
 * whoever first published it. A version runs the shared checks before anything is stored, waits
 * unlisted for the signer, and its number never names other bytes.
 */

async function account(request: Request, context: Context): Promise<MarketGrantClaims | Response> {
  const token = bearer(request);
  if (!token) return failure(401, "unauthorized", "Sign in to publish.");
  const keys = await context.grantKeys.get();
  if (!keys) return failure(503, "unavailable", "Publishing can't check sign-ins right now.");
  try {
    return verifyMarketGrant(token, keys, context.now);
  } catch (error) {
    if (error instanceof GrantError)
      return failure(401, "unauthorized", "That sign-in isn't one for publishing.");
    throw error;
  }
}

const notYours = () => failure(403, "forbidden", "Another publisher owns this entry.");
const reused = () =>
  failure(409, "conflict", "That version number already names other files; publish a new one.");

const accepted = (key: VersionKey, hash: string, status: number) =>
  json({ status: "pending", ...key, hash }, status);

export async function publish(
  request: Request,
  url: URL,
  key: EntryKey,
  context: Context,
): Promise<Response> {
  const db = context.env.MARKET;
  const claims = await account(request, context);
  if (claims instanceof Response) return claims;
  const version = MarketVersion.safeParse(url.searchParams.get("version")).data;
  if (!version)
    return refused([{ message: "Give a version number, such as 1.0.0 (version=...)." }]);
  let publisher = await publisherOf(db, claims.account);
  const wanted = url.searchParams.get("publisher");
  if (!publisher) {
    if (!MarketPublisherName.safeParse(wanted).success)
      return refused([
        {
          message:
            "Choose a publisher name for your first publish (publisher=...): lowercase letters, digits and single dashes, at most 32.",
        },
      ]);
    if (await nameTaken(db, wanted ?? ""))
      return failure(409, "conflict", "That publisher name is taken.");
  }
  const owner = await ownerOf(db, key.type, key.name);
  if (owner !== undefined && owner !== publisher?.id) return notYours();

  const body = await readCapped(request, maxArchiveBytes);
  if (!body) return failure(413, "too_large", `An archive is at most ${maxArchiveBytes} bytes.`);
  const checked = checkArchive(key.type, key.name, body);
  if (checked.problems.length > 0) return refused(checked.problems);

  const versionKey = { ...key, version };
  const existing = await storedVersion(db, versionKey);
  if (existing)
    return existing.hash === checked.hash ? accepted(versionKey, checked.hash, 200) : reused();

  if (!publisher) {
    const claim = await claimPublisher(db, {
      id: context.newId(),
      account: claims.account,
      name: wanted ?? "",
      now: context.now,
    });
    if ("taken" in claim && claim.taken === "name")
      return failure(409, "conflict", "That publisher name is taken.");
    publisher = "claimed" in claim ? claim.claimed : claim.publisher;
  }

  await putOnce(context.env.OBJECTS, checked.hash, () => writeArchive(checked.files));
  const stored = await storePending(db, {
    publisher: publisher.id,
    ...versionKey,
    hash: checked.hash,
    size: checked.size,
    published: context.now,
    listing: checked.listing,
  });
  if (stored.owner !== publisher.id) return notYours();
  if (stored.hash !== checked.hash) return reused();
  return accepted(versionKey, checked.hash, 201);
}

/**
 * Writes the archive at its hash unless one is there. The key is the content hash and the bytes
 * are the canonical archive of those files, so an object already there is these same bytes.
 */
async function putOnce(bucket: R2Bucket, hash: string, bytes: () => Uint8Array) {
  if (await bucket.head(objectKey(hash))) return;
  await bucket.put(objectKey(hash), bytes(), {
    onlyIf: new Headers({ "if-none-match": "*" }),
    httpMetadata: { contentType: "application/x-tar" },
  });
}

export async function withdraw(
  request: Request,
  key: VersionKey,
  context: Context,
): Promise<Response> {
  const db = context.env.MARKET;
  const claims = await account(request, context);
  if (claims instanceof Response) return claims;
  const publisher: MarketPublisher | undefined = await publisherOf(db, claims.account);
  const owner = await ownerOf(db, key.type, key.name);
  if (!owner) return failure(404, "not_found", "No such entry.");
  if (owner !== publisher?.id) return notYours();
  const stored = await storedVersion(db, key);
  if (!stored) return failure(404, "not_found", "No such version.");
  const parsed = WithdrawRequest.safeParse(await readJson(request, 16 * 1024));
  if (!parsed.success) return failure(400, "invalid", "Say why the version is withdrawn.");
  await addWithdrawal(db, {
    ...key,
    hash: stored.hash,
    reason: parsed.data.reason,
    at: context.now,
  });
  return json({ status: "pending", ...key, hash: stored.hash }, 202);
}
