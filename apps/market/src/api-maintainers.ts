import {
  verifyBlocklist,
  verifyNotices,
  verifyOfficialList,
  verifyVerifiedList,
} from "@ace/marketplace";
import {
  AppealAnswer,
  BlockDecision,
  CollectionsUpload,
  HoldDecision,
  ListingDecision,
  PublisherDecision,
  ReportResolution,
  SignedBlocklistUpload,
  SignedNoticesUpload,
  SignedOfficialUpload,
  SignedVerifiedUpload,
} from "@ace/protocol/marketplace";
import {
  listAnswer,
  malformed,
  marketKeys,
  noKeys,
  signatureRefused,
  signerAllowed,
} from "./api-signer.ts";
import { versionReportKey, type Context } from "./context.ts";
import { failure, json, notFound, readJson, refused } from "./http.ts";
import type { Route } from "./routes.ts";
import {
  answerAppeal,
  blockVersion,
  decideHold,
  decideListing,
  publisherVersions,
  queue,
  scanContext,
  setCollections,
  setPublisherState,
  type Decided,
} from "./store/maintainers.ts";
import { setBlocklist, setNotices, setOfficial, setVerified, signedText } from "./store/lists.ts";
import { markUsageDirty } from "./store/me-limits.ts";
import { listReports, resolveReport } from "./store/reports.ts";

/*
 * The signer's maintainer routes (ADR 0174 §9, §10, §13, §14): the queue, the scan context,
 * holds, blocks, listing edits, publishers, collections, the blocklist, the verified and official
 * lists, reports and appeals. Behind the signer's token; every signed list is checked against
 * the market's public keys before it is stored.
 */

const done = () => json({ status: "done" });
const decided = (result: Decided, conflict: string) =>
  result === "done"
    ? done()
    : result === "missing"
      ? notFound()
      : failure(409, "conflict", conflict);

export async function maintainerRoute(
  request: Request,
  route: Route,
  context: Context,
): Promise<Response | undefined> {
  if (!route.kind.startsWith("signer-")) return undefined;
  if (!(await signerAllowed(request, context)))
    return failure(401, "unauthorized", "Only the signer may do that.");
  const dbs = context.dbs;
  const body = () => readJson(request);
  const catalogue = "type" in route ? dbs.catalogue(route.type) : undefined;
  switch (route.kind) {
    case "signer-queue":
      return json(await queue(dbs, context.env.OBJECTS, context.now));
    case "signer-scan-context":
      return json(await scanContext(dbs, context.now));
    case "signer-hold": {
      const decision = HoldDecision.safeParse(await body());
      if (!decision.success) return malformed();
      if (!catalogue) return notFound();
      const result = await decideHold(catalogue, route, decision.data.decision, context.now);
      if (result === "done") await usageChanged(context, catalogue, route);
      // The signer's own re-scan that held it is the report a maintainer reads in the queue.
      if (result === "done" && decision.data.decision === "hold" && decision.data.scan)
        await context.env.OBJECTS.put(versionReportKey(route), JSON.stringify(decision.data.scan));
      return decided(result, "That version is listed or blocked; it can't be held or released.");
    }
    case "signer-block": {
      const decision = BlockDecision.safeParse(await body());
      if (!decision.success) return malformed();
      if (!catalogue) return notFound();
      const result = await blockVersion(catalogue, route, decision.data.reason, context.now);
      if (result === "done") await usageChanged(context, catalogue, route);
      if (result === "done" && decision.data.scan)
        await context.env.OBJECTS.put(versionReportKey(route), JSON.stringify(decision.data.scan));
      return decided(result, "That version is listed; revoke it instead.");
    }
    case "signer-listing": {
      const decision = ListingDecision.safeParse(await body());
      if (!decision.success) return malformed();
      if (!catalogue) return notFound();
      return decided(
        await decideListing(catalogue, route, decision.data.decision === "approve", context.now),
        "",
      );
    }
    case "signer-publisher": {
      const decision = PublisherDecision.safeParse(await body());
      if (!decision.success) return malformed();
      return decided(
        await setPublisherState(
          dbs,
          route.handle,
          decision.data.state,
          decision.data.reason,
          context.now,
        ),
        "",
      );
    }
    case "signer-publisher-read": {
      const found = await publisherVersions(dbs, route.handle);
      return found ? json(found) : notFound();
    }
    case "signer-collections": {
      const upload = CollectionsUpload.safeParse(await body());
      if (!upload.success) return malformed();
      const ids = upload.data.collections.map((collection) => collection.id);
      if (new Set(ids).size !== ids.length)
        return failure(400, "invalid", "A collection is listed twice.");
      await setCollections(dbs.lists, upload.data.collections);
      return json({ status: "stored" });
    }
    case "signer-blocklist":
      return blocklist(request, context);
    case "signer-verified":
      return verified(request, context);
    case "signer-official":
      return official(request, context);
    case "signer-notices":
      return notices(request, context);
    case "signer-reports":
      return json({ reports: await listReports(dbs.moderation) });
    case "signer-report": {
      const resolution = ReportResolution.safeParse(await body());
      if (!resolution.success) return malformed();
      return (await resolveReport(dbs.moderation, route.id, resolution.data, context.now))
        ? done()
        : notFound();
    }
    case "signer-appeal": {
      const answer = AppealAnswer.safeParse(await body());
      if (!answer.success) return malformed();
      return decided(
        await answerAppeal(dbs, route.id, answer.data, context.now),
        "That appeal is already answered.",
      );
    }
    default:
      return undefined;
  }
}

/** A hold, release or block changes what counts against the owner's quota: reconcile it. */
async function usageChanged(
  context: Context,
  catalogue: D1Database,
  key: { type: string; name: string },
) {
  const owner = await catalogue
    .prepare("SELECT publisher FROM entries WHERE type = ?1 AND name = ?2")
    .bind(key.type, key.name)
    .first<{ publisher: string }>();
  if (owner) await markUsageDirty(context.dbs.publishers, owner.publisher, context.now).run();
}

async function blocklist(request: Request, context: Context) {
  const upload = SignedBlocklistUpload.safeParse(await readJson(request, 8 * 1024 * 1024));
  if (!upload.success) return malformed();
  const keys = marketKeys(context);
  if (!keys) return noKeys();
  let list;
  try {
    list = verifyBlocklist(upload.data.blocklist, keys);
  } catch (error) {
    return signatureRefused(error);
  }
  const stored = await setBlocklist(context.dbs.moderation, {
    issued: list.issued,
    signed: signedText(upload.data.blocklist),
    basedOn: upload.data.basedOn,
  });
  return listAnswer(stored, list.issued);
}

async function verified(request: Request, context: Context) {
  const upload = SignedVerifiedUpload.safeParse(await readJson(request, 8 * 1024 * 1024));
  if (!upload.success) return malformed();
  const keys = marketKeys(context);
  if (!keys) return noKeys();
  let list;
  try {
    list = verifyVerifiedList(upload.data.verified, keys);
  } catch (error) {
    return signatureRefused(error);
  }
  const { results } = await context.dbs.publishers
    .prepare(
      `SELECT id, name FROM publishers WHERE id IN (SELECT json_extract(value, '$.id')
        FROM json_each(?1))`,
    )
    .bind(JSON.stringify(list.publishers))
    .all<{ id: string; name: string }>();
  const known = new Map(results.map((row) => [row.id, row.name]));
  const strangers = list.publishers.filter((entry) => known.get(entry.id) !== entry.handle);
  if (strangers.length > 0)
    return refused(
      strangers.map((entry) => ({
        message: `${entry.handle} isn't the handle of publisher ${entry.id}`,
      })),
    );
  const stored = await setVerified(
    context.dbs,
    { body: list, signed: signedText(upload.data.verified), basedOn: upload.data.basedOn },
    upload.data.revoked,
    context.now,
  );
  return listAnswer(stored, list.issued);
}

async function official(request: Request, context: Context) {
  const upload = SignedOfficialUpload.safeParse(await readJson(request));
  if (!upload.success) return malformed();
  const keys = marketKeys(context);
  if (!keys) return noKeys();
  let list;
  try {
    list = verifyOfficialList(upload.data.official, keys);
  } catch (error) {
    return signatureRefused(error);
  }
  if (list.publisher.name !== "ace")
    return refused([{ message: "The official list names the ace publisher only" }]);
  const stored = await setOfficial(
    context.dbs.publishers,
    { body: list, signed: signedText(upload.data.official), basedOn: upload.data.basedOn },
    context.now,
  );
  if (stored === "publisher-taken")
    return failure(409, "conflict", "Another publisher id holds the ace handle.");
  return listAnswer(stored, list.issued);
}

async function notices(request: Request, context: Context) {
  const upload = SignedNoticesUpload.safeParse(await readJson(request));
  if (!upload.success) return malformed();
  const keys = marketKeys(context);
  if (!keys) return noKeys();
  let list;
  try {
    list = verifyNotices(upload.data.notices, keys);
  } catch (error) {
    return signatureRefused(error);
  }
  const stored = await setNotices(context.dbs.lists, {
    issued: list.issued,
    signed: signedText(upload.data.notices),
    basedOn: upload.data.basedOn,
  });
  return listAnswer(stored, list.issued);
}
