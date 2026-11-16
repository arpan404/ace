import { sha256Hex } from "@ace/marketplace";
import { stripImage } from "@ace/marketplace/image";
import { linkProblem } from "@ace/marketplace/profile";
import { scanListing } from "@ace/marketplace/scan";
import {
  MarketAppealRequest,
  MarketArchivedSet,
  MarketChangelogSet,
  MarketDeprecation,
  MarketLatestSet,
  MarketListingEdit,
  MarketTransferOffer,
  MarketVisibilitySet,
  MarketWithdrawRequest,
  type MarketScanReport,
} from "@ace/protocol/marketplace";
import { notYours, type Authed, type AuthedPublisher } from "./auth.ts";
import { listingReportKey, previewKey, type Context } from "./context.ts";
import { failure, json, readCapped, readJson, refused } from "./http.ts";
import { currentListing, liveVersions } from "./rules.ts";
import type { Route } from "./routes.ts";
import {
  applyListing,
  deleteNeverListed,
  ownEntry,
  ownEntryRow,
  setArchived,
  setChangelog,
  setDeprecated,
  setLatestPick,
  setPendingListing,
  setVisibility,
} from "./store/me-entries.ts";
import { blockReason, putReport, scanContext } from "./store/me-scan.ts";
import { addAppeal, offerTransfer, signals } from "./store/me-transfers.ts";
import { pinsOf, publisherByHandle, publisherById } from "./store/profiles.ts";
import { addWithdrawal, storedVersion } from "./store/publish.ts";
import { versionsOf } from "./store/read.ts";
import { entryManagement } from "./store/rows.ts";

/*
 * A publisher's actions on one of their entries (ADR 0173 §5), under `/v1/me/entries/{type}/
 * {name}/…`. Each checks, on every request, that the entry's publisher is the account's.
 * Published bytes are never changed: withdrawal is the only removal of a published version.
 */

type EntryRoute = Extract<Route, { type: string; name: string }>;
const entryKinds = new Set<Route["kind"]>([
  "me-entry",
  "me-entry-delete",
  "me-listing",
  "me-preview",
  "me-latest",
  "me-visibility",
  "me-archived",
  "me-entry-withdraw",
  "me-transfer",
  "me-signals",
  "me-changelog",
  "me-deprecate",
  "me-undeprecate",
  "me-version-withdraw",
  "me-appeal",
]);

const invalid = (message: string) => failure(400, "invalid", message);
const noEntry = () => failure(404, "not_found", "No such entry.");
const noVersion = () => failure(404, "not_found", "No such version.");
const done = () => json({ status: "done" });
const blocked = (scan: MarketScanReport) =>
  json({ error: "blocked", message: `The scan refused this: ${blockReason(scan)}`, scan }, 422);

export async function meEntryRoute(
  request: Request,
  route: Route,
  context: Context,
  authed: Authed,
): Promise<Response | undefined> {
  if (!entryKinds.has(route.kind) || !("type" in route)) return undefined;
  const db = context.env.MARKET;
  const row = await ownEntryRow(db, route);
  if (!row) return noEntry();
  const publisher = authed.publisher;
  if (!publisher || row.publisher !== publisher.id) return notYours();
  const key = { type: route.type, name: route.name };
  const now = context.now;
  switch (route.kind) {
    case "me-entry": {
      const own = await publisherById(db, publisher.id);
      return json(await ownEntry(db, context.env.OBJECTS, row, own ? pinsOf(own) : []));
    }
    case "me-entry-delete":
      return (await deleteNeverListed(db, context.env.OBJECTS, key, publisher.id))
        ? done()
        : failure(409, "conflict", "An entry that was ever listed can only be withdrawn.");
    case "me-listing": {
      const parsed = MarketListingEdit.safeParse(await readJson(request, 64 * 1024));
      if (!parsed.success) return invalid("That isn't a listing.");
      return editListing(context, publisher, row.reviewed === 1, key, parsed.data);
    }
    case "me-preview": {
      const bytes = await readCapped(request, 1024 * 1024);
      if (!bytes) return failure(413, "too_large", "A listing picture is at most 1 MB.");
      const image = stripImage(bytes, "preview");
      if ("problem" in image) return refused([image.problem]);
      const sha = sha256Hex(image.bytes);
      await context.env.OBJECTS.put(previewKey(sha), image.bytes, {
        httpMetadata: { contentType: image.type },
      });
      const versions = await versionsOf(db, key.type, key.name);
      const listing = currentListing(
        key.name,
        versions,
        entryManagement(row, { state: row.publisher_state, verified: row.publisher_verified }),
      );
      const previews = [...listing.previews];
      if (route.index > previews.length)
        return invalid(`Add listing pictures in order: the next one is ${previews.length}.`);
      previews[route.index] = sha;
      return editListing(context, publisher, row.reviewed === 1, key, { ...listing, previews });
    }
    case "me-latest": {
      const parsed = MarketLatestSet.safeParse(await readJson(request, 4 * 1024));
      if (!parsed.success) return invalid("Name a live version, or null for the newest.");
      const pick = parsed.data.version;
      if (pick !== null) {
        const live = liveVersions(await versionsOf(db, key.type, key.name));
        if (!live.some((version) => version.version === pick))
          return refused([{ message: `${pick} isn't a live version of this entry.` }]);
      }
      await setLatestPick(db, key, pick, now);
      return done();
    }
    case "me-visibility": {
      const parsed = MarketVisibilitySet.safeParse(await readJson(request, 4 * 1024));
      if (!parsed.success) return invalid("Visibility is listed or unlisted.");
      await setVisibility(db, key, parsed.data.visibility, now);
      return done();
    }
    case "me-archived": {
      const parsed = MarketArchivedSet.safeParse(await readJson(request, 4 * 1024));
      if (!parsed.success) return invalid("Say whether the entry is archived.");
      await setArchived(db, key, parsed.data.archived, now);
      return done();
    }
    case "me-entry-withdraw": {
      const parsed = MarketWithdrawRequest.safeParse(await readJson(request, 16 * 1024));
      if (!parsed.success) return invalid("Say why the entry is withdrawn.");
      const live = liveVersions(await versionsOf(db, key.type, key.name));
      if (live.length === 0) return refused([{ message: "This entry has no live version." }]);
      for (const version of live)
        await addWithdrawal(db, {
          ...key,
          version: version.version,
          hash: version.hash,
          reason: parsed.data.reason,
          at: now,
        });
      return json({ status: "pending", versions: live.map((version) => version.version) }, 202);
    }
    case "me-transfer":
      return transfer(request, context, publisher, key);
    case "me-signals": {
      const versions = await versionsOf(db, key.type, key.name);
      return json(
        await signals(
          db,
          key as { type: EntryRoute["type"]; name: string },
          row.latest ?? undefined,
          versions.filter((version) => version.listed).map((version) => version.version),
          now,
        ),
      );
    }
    default:
      return versionAction(request, route, context, publisher);
  }
}

/**
 * A listing edit (ADR 0173 §5): scanned; a block refuses it; an entry with ace's review mark gets
 * it only after a maintainer approves, and so does any edit the scan warns about; the rest apply
 * at once.
 */
async function editListing(
  context: Context,
  publisher: AuthedPublisher,
  reviewed: boolean,
  key: { type: string; name: string },
  listing: MarketListingEdit,
): Promise<Response> {
  const problems = listing.links.flatMap((link) => {
    const problem = linkProblem(link);
    return problem ? [problem] : [];
  });
  for (const sha of listing.previews)
    if (!(await context.env.OBJECTS.head(previewKey(sha))))
      problems.push({ message: `Upload the picture ${sha.slice(0, 12)}… first.` });
  if (problems.length > 0) return refused(problems);
  const scan = scanListing(
    listing,
    await scanContext(
      context.env.MARKET,
      { handle: publisher.name, official: publisher.official },
      context.env.MARKET_PUBLIC_KEYS,
    ),
  );
  if (scan.verdict === "block") return blocked(scan);
  if (reviewed || scan.verdict === "warn") {
    await setPendingListing(context.env.MARKET, key, { listing, scan, at: context.now });
    await putReport(context.env.OBJECTS, listingReportKey(key), scan);
    return json({ status: "pending", scan }, 202);
  }
  await applyListing(context.env.MARKET, key, listing, context.now);
  return json({ status: "done", scan });
}

async function transfer(
  request: Request,
  context: Context,
  publisher: AuthedPublisher,
  key: { type: string; name: string },
): Promise<Response> {
  const db = context.env.MARKET;
  const parsed = MarketTransferOffer.safeParse(await readJson(request, 4 * 1024));
  if (!parsed.success) return invalid("Name the publisher to offer it to.");
  const to = await publisherByHandle(db, parsed.data.to);
  if (!to || to.state !== "active")
    return failure(404, "not_found", "No active publisher has that handle.");
  if (to.id === publisher.id) return invalid("This entry is already yours.");
  const offer = await offerTransfer(db, {
    id: context.newId("trf"),
    entry: key as { type: EntryRoute["type"]; name: string },
    from: publisher.id,
    to: to.id,
    now: context.now,
  });
  return offer ? json(offer, 201) : failure(409, "conflict", "The offer couldn't be made.");
}

async function versionAction(
  request: Request,
  route: Route,
  context: Context,
  publisher: AuthedPublisher,
): Promise<Response | undefined> {
  if (!("version" in route)) return undefined;
  const db = context.env.MARKET;
  const key = { type: route.type, name: route.name, version: route.version };
  const stored = await storedVersion(db, key);
  if (!stored) return noVersion();
  switch (route.kind) {
    case "me-changelog": {
      const parsed = MarketChangelogSet.safeParse(await readJson(request, 32 * 1024));
      if (!parsed.success) return invalid("A changelog is at most 4,000 characters.");
      const scan = scanListing(
        { changelog: parsed.data.text },
        await scanContext(
          db,
          { handle: publisher.name, official: publisher.official },
          context.env.MARKET_PUBLIC_KEYS,
        ),
      );
      if (scan.verdict === "block") return blocked(scan);
      await setChangelog(db, key, parsed.data.text, context.now);
      return json({ status: "done", scan });
    }
    case "me-deprecate": {
      const parsed = MarketDeprecation.safeParse(await readJson(request, 4 * 1024));
      if (!parsed.success) return invalid("A deprecation needs a note of at most 500 characters.");
      await setDeprecated(db, key, parsed.data.note, context.now);
      return done();
    }
    case "me-undeprecate":
      await setDeprecated(db, key, null, context.now);
      return done();
    case "me-version-withdraw": {
      if (stored.state === "blocked") return noVersion();
      const parsed = MarketWithdrawRequest.safeParse(await readJson(request, 16 * 1024));
      if (!parsed.success) return invalid("Say why the version is withdrawn.");
      await addWithdrawal(db, {
        ...key,
        hash: stored.hash,
        reason: parsed.data.reason,
        at: context.now,
      });
      return json({ status: "pending", ...key, hash: stored.hash }, 202);
    }
    case "me-appeal": {
      if (stored.state !== "blocked" && stored.state !== "held")
        return failure(409, "conflict", "Only a blocked or held version can be appealed.");
      const parsed = MarketAppealRequest.safeParse(await readJson(request, 16 * 1024));
      if (!parsed.success) return invalid("An appeal needs a note of at most 2,000 characters.");
      const replacement = parsed.data.replacement;
      if (replacement !== undefined) {
        const other = await storedVersion(db, { ...key, version: replacement });
        if (!other || replacement === key.version)
          return refused([{ message: `Upload ${replacement} of this entry before naming it.` }]);
      }
      const id = context.newId("apl");
      const added = await addAppeal(db, {
        id,
        ...key,
        publisher: publisher.id,
        note: parsed.data.note,
        replacement,
        now: context.now,
      });
      return added
        ? json({ status: "done", id }, 201)
        : failure(409, "conflict", "This version already has an open appeal.");
    }
    default:
      return undefined;
  }
}
