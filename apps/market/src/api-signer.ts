import {
  CategoriesUpload,
  FeaturedUpload,
  MarketKeySet,
  SignatureError,
  SignedReviewUpload,
  SignedVersionUpload,
  SignedWithdrawnUpload,
  verifyManifest,
  verifyReviewMark,
  verifyWithdrawn,
} from "@ace/marketplace";
import { objectKey, type Context } from "./context.ts";
import { bearer, failure, json, notFound, readJson, refused, sameSecret } from "./http.ts";
import type { Route, VersionKey } from "./routes.ts";
import { withdrawnList } from "./store/read.ts";
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

async function signerAllowed(request: Request, context: Context): Promise<boolean> {
  const expected = context.env.MARKET_SIGNER_TOKEN;
  const given = bearer(request);
  if (!expected || !given) return false;
  return sameSecret(given, expected);
}

function marketKeys(context: Context): MarketKeySet | undefined {
  try {
    return MarketKeySet.safeParse(JSON.parse(context.env.MARKET_PUBLIC_KEYS ?? "")).data;
  } catch {
    return undefined;
  }
}

const malformed = () => failure(400, "invalid", "That upload isn't in the signer's form.");
const noKeys = () => failure(503, "unavailable", "The market has no public keys configured.");
const signatureRefused = (error: unknown) => {
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
  const db = context.env.MARKET;
  switch (route.kind) {
    case "signer-pending": {
      const [versions, withdrawals, list] = await Promise.all([
        pendingVersions(db),
        pendingWithdrawals(db),
        withdrawnList(db),
      ]);
      return json({ versions, withdrawals, ...(list ? { withdrawn: list.signed } : {}) });
    }
    case "signer-object": {
      if (!(await hashIsStored(db, route.hash))) return notFound();
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
      await setCategories(db, upload.data.categories);
      return json({ status: "stored" });
    }
    case "signer-featured": {
      const upload = FeaturedUpload.safeParse(await readJson(request));
      if (!upload.success) return malformed();
      const reviewed = await reviewedEntries(db, upload.data.entries);
      const others = upload.data.entries.filter(
        (entry) => !reviewed.has(`${entry.type}/${entry.name}`),
      );
      if (others.length > 0)
        return refused(
          others.map((entry) => ({
            message: `${entry.type}/${entry.name} isn't a listed, reviewed entry`,
          })),
        );
      await setFeatured(db, upload.data.entries);
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
  const stored = await versionForSigning(context.env.MARKET, key);
  if (!stored) return notFound();
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
  await listVersion(context.env.MARKET, key, JSON.stringify(upload.data.manifest), context.now);
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
  const stored = await versionForSigning(context.env.MARKET, key);
  if (!stored) return notFound();
  if (mark.type !== key.type || mark.name !== key.name || mark.hash !== stored.hash)
    return refused([{ message: "The review mark names another entry or other files" }]);
  await setReview(
    context.env.MARKET,
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
    context.env.MARKET,
    {
      issued: list.issued,
      signed: JSON.stringify(upload.data.withdrawn),
      withdrawn: list.withdrawn,
    },
    context.now,
  );
  return stored
    ? json({ status: "stored", issued: list.issued })
    : failure(409, "conflict", "Another list issued at or after this one is already stored.");
}
