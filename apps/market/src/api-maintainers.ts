import { verifyBlocklist, verifyOfficialList, verifyVerifiedList } from "@ace/marketplace";
import {
  AppealAnswer,
  BlockDecision,
  CollectionsUpload,
  HoldDecision,
  ListingDecision,
  PublisherDecision,
  ReportResolution,
  SignedBlocklistUpload,
  SignedOfficialUpload,
  SignedVerifiedUpload,
} from "@ace/protocol/marketplace";
import { malformed, marketKeys, noKeys, signatureRefused, signerAllowed } from "./api-signer.ts";
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
import { setBlocklist, setOfficial, setVerified } from "./store/lists.ts";
import { listReports, resolveReport } from "./store/reports.ts";

/*
 * The signer's maintainer routes (ADR 0173 §9, §10, §13, §14): the queue, the scan context,
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
const older = () =>
  failure(409, "conflict", "Another list issued at or after this one is already stored.");

export async function maintainerRoute(
  request: Request,
  route: Route,
  context: Context,
): Promise<Response | undefined> {
  if (!route.kind.startsWith("signer-")) return undefined;
  if (!(await signerAllowed(request, context)))
    return failure(401, "unauthorized", "Only the signer may do that.");
  const db = context.env.MARKET;
  const body = () => readJson(request);
  switch (route.kind) {
    case "signer-queue":
      return json(await queue(db, context.env.OBJECTS, context.now));
    case "signer-scan-context":
      return json(await scanContext(db, context.now));
    case "signer-hold": {
      const decision = HoldDecision.safeParse(await body());
      if (!decision.success) return malformed();
      return decided(
        await decideHold(db, route, decision.data.decision, context.now),
        "That version is listed or blocked; it can't be held or released.",
      );
    }
    case "signer-block": {
      const decision = BlockDecision.safeParse(await body());
      if (!decision.success) return malformed();
      const result = await blockVersion(db, route, decision.data.reason, context.now);
      if (result === "done" && decision.data.scan)
        await context.env.OBJECTS.put(versionReportKey(route), JSON.stringify(decision.data.scan));
      return decided(result, "That version is listed; revoke it instead.");
    }
    case "signer-listing": {
      const decision = ListingDecision.safeParse(await body());
      if (!decision.success) return malformed();
      return decided(
        await decideListing(db, route, decision.data.decision === "approve", context.now),
        "",
      );
    }
    case "signer-publisher": {
      const decision = PublisherDecision.safeParse(await body());
      if (!decision.success) return malformed();
      return decided(
        await setPublisherState(
          db,
          route.handle,
          decision.data.state,
          decision.data.reason,
          context.now,
        ),
        "",
      );
    }
    case "signer-publisher-read": {
      const found = await publisherVersions(db, route.handle);
      return found ? json(found) : notFound();
    }
    case "signer-collections": {
      const upload = CollectionsUpload.safeParse(await body());
      if (!upload.success) return malformed();
      const ids = upload.data.collections.map((collection) => collection.id);
      if (new Set(ids).size !== ids.length)
        return failure(400, "invalid", "A collection is listed twice.");
      await setCollections(db, upload.data.collections);
      return json({ status: "stored" });
    }
    case "signer-blocklist":
      return blocklist(request, context);
    case "signer-verified":
      return verified(request, context);
    case "signer-official":
      return official(request, context);
    case "signer-reports":
      return json({ reports: await listReports(db) });
    case "signer-report": {
      const resolution = ReportResolution.safeParse(await body());
      if (!resolution.success) return malformed();
      return (await resolveReport(db, route.id, resolution.data, context.now))
        ? done()
        : notFound();
    }
    case "signer-appeal": {
      const answer = AppealAnswer.safeParse(await body());
      if (!answer.success) return malformed();
      return decided(
        await answerAppeal(db, route.id, answer.data, context.now),
        "That appeal is already answered.",
      );
    }
    default:
      return undefined;
  }
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
  return (await setBlocklist(
    context.env.MARKET,
    list.issued,
    JSON.stringify(upload.data.blocklist),
  ))
    ? json({ status: "stored", issued: list.issued })
    : older();
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
  const db = context.env.MARKET;
  const { results } = await db
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
    db,
    { body: list, signed: JSON.stringify(upload.data.verified) },
    upload.data.revoked,
    context.now,
  );
  return stored ? json({ status: "stored", issued: list.issued }) : older();
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
    context.env.MARKET,
    { body: list, signed: JSON.stringify(upload.data.official) },
    context.now,
  );
  if (stored === "publisher-taken")
    return failure(409, "conflict", "Another publisher id holds the ace handle.");
  return stored === "stored" ? json({ status: "stored", issued: list.issued }) : older();
}
