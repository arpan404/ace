import {
  SignatureError,
  verifyManifest,
  verifyReviewMark,
  verifyWithdrawn,
} from "@ace/marketplace";
import {
  CategoriesUpload,
  FeaturedUpload,
  MarketKeySet,
  SignedReviewUpload,
  SignedVersionUpload,
  SignedWithdrawnUpload,
} from "@ace/protocol/marketplace";
import { objectKey, type Context } from "./context.ts";
import { bearer, failure, json, notFound, readJson, refused, sameSecret } from "./http.ts";
import type { Route, VersionKey } from "./routes.ts";
import { withdrawnList } from "./store/read.ts";
import { listDb, signedList, signedText, type ListStored } from "./store/lists.ts";
import {
  hashIsStored,
  listVersion,
  pendingVersions,
  pendingWithdrawals,
  reviewedEntries,
  setCategories,
  setFeatured,
  setReview,
  setWithdrawn,
  versionForSigning,
} from "./store/signer.ts";

/*
 * The signer's routes (ADR 0168 §6). The signing key never sits here: the signer pulls what
 * waits, checks and signs it on a maintainer's machine, and uploads signatures, which this
 * Worker checks against the market's public keys before anything is listed.
 */

export async function signerAllowed(request: Request, context: Context): Promise<boolean> {
  const expected = context.env.MARKET_SIGNER_TOKEN;
  const given = bearer(request);
  if (!expected || !given) return false;
  return sameSecret(given, expected);
}

export function marketKeys(context: Context): MarketKeySet | undefined {
  try {
    return MarketKeySet.safeParse(JSON.parse(context.env.MARKET_PUBLIC_KEYS ?? "")).data;
  } catch {
    return undefined;
  }
}

export const malformed = () => failure(400, "invalid", "That upload isn't in the signer's form.");
export const noKeys = () =>
  failure(503, "unavailable", "The market has no public keys configured.");
/** The answer to a signed list's upload, by what became of it. */
export const listAnswer = (outcome: ListStored, issued: number) =>
  outcome === "stored"
    ? json({ status: "stored", issued })
    : outcome === "changed"
      ? failure(409, "conflict", "The list changed since this edit read it; run the command again.")
      : failure(409, "conflict", "Another list issued at or after this one is already stored.");
export const signatureRefused = (error: unknown) => {
  if (error instanceof SignatureError) return refused([{ message: error.message }]);
  throw error;
};

export async function signerRoute(
  request: Request,
  route: Route,
  context: Context,
): Promise<Response | undefined> {
  if (!route.kind.startsWith("signer-")) return undefined;
  if (!(await signerAllowed(request, context)))
    return failure(401, "unauthorized", "Only the signer may do that.");
  const dbs = context.dbs;
  switch (route.kind) {
    case "signer-pending": {
      // Only versions waiting for the signer: held and blocked ones wait for a maintainer.
      const [versions, withdrawals, list, blocklist, verified, official, notices] =
        await Promise.all([
          pendingVersions(dbs),
          pendingWithdrawals(dbs),
          withdrawnList(dbs.lists),
          signedList(listDb(dbs, "blocklist"), "blocklist"),
          signedList(listDb(dbs, "verified"), "verified"),
          signedList(listDb(dbs, "official"), "official"),
          signedList(listDb(dbs, "notices"), "notices"),
        ]);
      return json({
        versions,
        withdrawals,
        ...(list ? { withdrawn: list.signed } : {}),
        ...(blocklist ? { blocklist: blocklist.signed } : {}),
        ...(verified ? { verified: verified.signed } : {}),
        ...(official ? { official: official.signed } : {}),
        ...(notices ? { notices: notices.signed } : {}),
      });
    }
    case "signer-object": {
      if (!(await hashIsStored(dbs, route.hash))) return notFound();
      const stored = await context.env.OBJECTS.get(objectKey(route.hash));
      return stored
        ? new Response(stored.body, { headers: { "content-type": "application/x-tar" } })
        : notFound();
    }
    case "signer-version":
      return signVersion(request, route, context);
    case "signer-review":
      return review(request, route, context);
    case "signer-withdrawn":
      return withdrawn(request, context);
    case "signer-categories": {
      const upload = CategoriesUpload.safeParse(await readJson(request));
      if (!upload.success) return malformed();
      const ids = upload.data.categories.map((category) => category.id);
      if (new Set(ids).size !== ids.length)
        return failure(400, "invalid", "A category is listed twice.");
      await setCategories(dbs.lists, upload.data.categories);
      return json({ status: "stored" });
    }
    case "signer-featured": {
      const upload = FeaturedUpload.safeParse(await readJson(request));
      if (!upload.success) return malformed();
      const reviewed = await reviewedEntries(dbs, upload.data.entries);
      const others = upload.data.entries.filter(
        (entry) => !reviewed.has(`${entry.type}/${entry.name}`),
      );
      if (others.length > 0)
        return refused(
          others.map((entry) => ({
            message: `${entry.type}/${entry.name} isn't a listed, reviewed entry`,
          })),
        );
      await setFeatured(dbs.lists, upload.data.entries);
      return json({ status: "stored" });
    }
    default:
      return undefined;
  }
}

async function signVersion(request: Request, key: VersionKey, context: Context) {
  const upload = SignedVersionUpload.safeParse(await readJson(request));
  if (!upload.success) return malformed();
  const keys = marketKeys(context);
  if (!keys) return noKeys();
  let manifest;
  try {
    manifest = verifyManifest(upload.data.manifest, keys);
  } catch (error) {
    return signatureRefused(error);
  }
  const db = context.dbs.catalogue(key.type);
  const stored = db ? await versionForSigning(db, key) : undefined;
  if (!db || !stored) return notFound();
  // A held or blocked version waits for a maintainer, whatever the signer says.
  if (stored.state !== "pending" && stored.state !== "listed")
    return failure(409, "conflict", `That version is ${stored.state}; a maintainer decides it.`);
  const matches =
    manifest.type === key.type &&
    manifest.name === key.name &&
    manifest.version === key.version &&
    manifest.publisher.id === stored.publisher.id &&
    manifest.publisher.name === stored.publisher.name &&
    manifest.hash === stored.hash &&
    manifest.size === stored.size;
  if (!matches)
    return refused([{ message: "The manifest names another version, publisher or files" }]);
  if (
    !(await listVersion(
      db,
      key,
      {
        manifest: JSON.stringify(upload.data.manifest),
        hash: stored.hash,
        size: stored.size,
        publisher: stored.publisher.id,
      },
      context.now,
    ))
  )
    return failure(
      409,
      "conflict",
      "That version was held, blocked or submitted again; a maintainer decides it.",
    );
  return json({ status: "listed", ...key, hash: stored.hash });
}

async function review(request: Request, key: VersionKey, context: Context) {
  const upload = SignedReviewUpload.safeParse(await readJson(request));
  if (!upload.success) return malformed();
  const keys = marketKeys(context);
  if (!keys) return noKeys();
  let mark;
  try {
    mark = verifyReviewMark(upload.data.review, keys);
  } catch (error) {
    return signatureRefused(error);
  }
  const db = context.dbs.catalogue(key.type);
  const stored = db ? await versionForSigning(db, key) : undefined;
  if (!db || !stored) return notFound();
  if (mark.type !== key.type || mark.name !== key.name || mark.hash !== stored.hash)
    return refused([{ message: "The review mark names another entry or other files" }]);
  await setReview(
    db,
    key,
    { signed: JSON.stringify(upload.data.review), reviewed: mark.reviewed, byAce: mark.byAce },
    context.now,
  );
  return json({ status: "stored", ...key });
}

async function withdrawn(request: Request, context: Context) {
  const upload = SignedWithdrawnUpload.safeParse(await readJson(request, 8 * 1024 * 1024));
  if (!upload.success) return malformed();
  const keys = marketKeys(context);
  if (!keys) return noKeys();
  let list;
  try {
    list = verifyWithdrawn(upload.data.withdrawn, keys);
  } catch (error) {
    return signatureRefused(error);
  }
  const stored = await setWithdrawn(
    context.dbs,
    {
      issued: list.issued,
      signed: signedText(upload.data.withdrawn),
      withdrawn: list.withdrawn,
      basedOn: upload.data.basedOn,
    },
    context.now,
  );
  return listAnswer(stored, list.issued);
}
