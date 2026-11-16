import { maxArchiveBytes, writeArchive } from "@ace/marketplace";
import type { CheckedEntry } from "@ace/marketplace/checks";
import { handleProblem, skeleton } from "@ace/marketplace/profile";
import { disposition } from "@ace/marketplace/scan";
import {
  MarketDraftPatch,
  MarketEntryName,
  MarketEntryType,
  MarketHandle,
  MarketVersion,
  WithdrawRequest,
  type MarketScanReport,
} from "@ace/protocol/marketplace";
import { authenticate, notYours, type Authed, type AuthedPublisher } from "./auth.ts";
import { draftKey, draftReportKey, objectKey, versionReportKey, type Context } from "./context.ts";
import { failure, json, readCapped, readJson, refused } from "./http.ts";
import { isNewPublisher, publisherLimits } from "./rules.ts";
import type { EntryKey, Route, VersionKey } from "./routes.ts";
import {
  advanceJob,
  deferJob,
  deleteDraft,
  deletePublishedDraft,
  draftBody,
  patchDraft,
  readDraft,
  scanJob,
  writeDraft,
  type DraftTable,
} from "./store/drafts.ts";
import { quotaRace, reserveUpload } from "./store/me-limits.ts";
import {
  blockReason,
  getReport,
  putReport,
  readChecked,
  scanContext,
  scanInput,
  scanWithin,
} from "./store/me-scan.ts";
import { handleTaken } from "./store/profiles.ts";
import {
  addWithdrawal,
  claimPublisher,
  hasVersions,
  ownerOf,
  storePending,
  storedVersion,
  type StoreGuard,
} from "./store/publish.ts";

/*
 * Publishing (ADR 0168 §7, ADR 0173 §5, §8, §9): the CLI's one-step upload and the app's drafts.
 * A market grant names the account; an entry belongs to whoever first published it. Every
 * version runs the format checks and the scan before anything is stored: a block is refused
 * (the CLI records it as a blocked version with its report), a warn, a new publisher's first
 * version and every version published as `ace` are held for a maintainer, the rest wait for the
 * signer. A version number never names other bytes, except one the scan blocked.
 */

const reused = () =>
  failure(409, "conflict", "That version number already names other files; publish a new one.");

const blocked = (scan: MarketScanReport) =>
  json(
    {
      error: "blocked",
      message: `The scan refused this version: ${blockReason(scan)}`,
      scan,
    },
    422,
  );

const quota = (message: string) => failure(429, "quota", message);
const changed = () =>
  failure(409, "conflict", "The draft changed while it was being published; try again.");

/** The publisher's caps, by their standing now (ADR 0173 §9). */
const capsOf = (publisher: AuthedPublisher, now: number) =>
  publisherLimits(isNewPublisher(publisher, now));

/** Writes the archive at its hash unless one is there: the key is its content hash. */
async function putOnce(bucket: R2Bucket, hash: string, bytes: () => Uint8Array) {
  if (await bucket.head(objectKey(hash))) return;
  await bucket.put(objectKey(hash), bytes(), {
    onlyIf: new Headers({ "if-none-match": "*" }),
    httpMetadata: { contentType: "application/x-tar" },
  });
}

/** Stores a scanned version that wasn't blocked, as pending or held; answers what the CLI reads. */
async function storeScanned(
  context: Context,
  publisher: AuthedPublisher,
  key: VersionKey,
  checked: CheckedEntry,
  scan: MarketScanReport,
  guard: StoreGuard,
  changelog?: string,
): Promise<Response> {
  const db = context.env.MARKET;
  const firstVersion = !(await hasVersions(db, publisher.id));
  const fate = disposition(scan, {
    newPublisher: isNewPublisher(publisher, context.now),
    firstVersion,
    official: publisher.official,
    approved: false,
  });
  if (fate === "block") return blocked(scan);
  await putOnce(context.env.OBJECTS, checked.hash, () => writeArchive(checked.files));
  const stored = await storePending(
    db,
    {
      publisher: publisher.id,
      ...key,
      hash: checked.hash,
      size: checked.size,
      published: context.now,
      listing: checked.listing,
      state: fate === "hold" ? "held" : "pending",
      verdict: scan.verdict,
      scanned: scan.scanner,
      ...(changelog ? { changelog } : {}),
    },
    guard,
  );
  if (stored.owner !== publisher.id) return notYours();
  if (stored.hash === undefined) {
    const draft = guard.draft ? await readDraft(db, guard.draft) : undefined;
    return guard.draft && draft?.hash !== checked.hash ? changed() : quota(quotaRace);
  }
  if (stored.hash !== checked.hash) return reused();
  await putReport(context.env.OBJECTS, versionReportKey(key), scan);
  return json({ status: "pending", ...key, hash: checked.hash, held: fate === "hold", scan }, 201);
}

/** The publisher's own handle check on a first publish: the rules, then lookalikes taken. */
async function handleRefusal(db: D1Database, handle: string, self?: string) {
  const problem = handleProblem(handle, { official: false });
  if (problem) return refused([problem]);
  if (await handleTaken(db, handle, skeleton(handle), self))
    return failure(409, "conflict", "That publisher name is taken.");
  return undefined;
}

export async function publish(
  request: Request,
  url: URL,
  key: EntryKey,
  context: Context,
): Promise<Response> {
  const db = context.env.MARKET;
  const authed = await authenticate(request, context);
  if (authed instanceof Response) return authed;
  const version = MarketVersion.safeParse(url.searchParams.get("version")).data;
  if (!version)
    return refused([{ message: "Give a version number, such as 1.0.0 (version=...)." }]);
  let publisher = authed.publisher;
  const wanted = url.searchParams.get("publisher") ?? "";
  if (!publisher) {
    if (!MarketHandle.safeParse(wanted).success)
      return refused([
        {
          message:
            "Choose a publisher name for your first publish (publisher=...): 3 to 32 lowercase letters, digits and single dashes.",
        },
      ]);
    const refusal = await handleRefusal(db, wanted);
    if (refusal) return refusal;
  }
  const owner = await ownerOf(db, key.type, key.name);
  if (owner !== undefined && owner !== publisher?.id) return notYours();

  const body = await readCapped(request, maxArchiveBytes);
  if (!body) return failure(413, "too_large", `An archive is at most ${maxArchiveBytes} bytes.`);
  const checked = readChecked(key.type, key.name, body);
  if (checked.problems.length > 0) return refused(checked.problems);

  const versionKey = { ...key, version };
  const existing = await storedVersion(db, versionKey);
  if (existing && existing.state !== "blocked")
    return existing.hash === checked.hash
      ? json({ status: "pending", ...versionKey, hash: checked.hash }, 200)
      : reused();

  if (!publisher) {
    const id = context.newId("pub");
    const claim = await claimPublisher(db, {
      id,
      account: authed.account,
      name: wanted,
      skeleton: skeleton(wanted),
      now: context.now,
    }).catch((error: unknown) => {
      if (error instanceof Error && /UNIQUE/i.test(error.message))
        return { taken: "name" as const };
      throw error;
    });
    if ("taken" in claim && claim.taken === "name")
      return failure(409, "conflict", "That publisher name is taken.");
    const claimed = "claimed" in claim ? claim.claimed : claim.publisher;
    publisher = {
      id: claimed.id,
      name: claimed.name,
      state: "active",
      created: context.now,
      liveVersions: 0,
      verified: false,
      official: false,
    };
  }

  const scanCtx = await scanContext(
    db,
    { handle: publisher.name, official: publisher.official },
    context.env.MARKET_PUBLIC_KEYS,
  );
  const input = scanInput(key.type, key.name, checked, scanCtx);
  const scanned = scanWithin(input);
  // An unfinished scan carries on as a draft, so the draft cap applies to it.
  const refusal = await reserveUpload(db, {
    publisher: publisher.id,
    newPublisher: isNewPublisher(publisher, context.now),
    size: checked.size,
    newDraft: !scanned.done,
    now: context.now,
  });
  if (refusal) return quota(refusal);
  const caps = capsOf(publisher, context.now);
  if (!scanned.done) {
    // Too much to read in one request: it carries on as a draft (ADR 0173 §8).
    const id = context.newId("drf");
    const written = await writeDraft(
      db,
      draftWrite(id, publisher.id, versionKey, checked, context.now),
      {
        done: false,
        job: { cursor: scanned.state.cursor, files: checked.files.length, state: scanned.state },
      },
      caps,
    );
    if (!written) return quota(quotaRace);
    await context.env.OBJECTS.put(draftKey(id), body);
    return json({ status: "scanning", ...versionKey, draft: id }, 202);
  }
  const scan = { ...scanned.report, hash: checked.hash };
  if (scan.verdict === "block") {
    const stored = await storePending(
      db,
      {
        publisher: publisher.id,
        ...versionKey,
        hash: checked.hash,
        size: checked.size,
        published: context.now,
        listing: checked.listing,
        state: "blocked",
        verdict: "block",
        blockReason: blockReason(scan),
        scanned: scan.scanner,
      },
      caps,
    );
    if (stored.owner !== publisher.id) return notYours();
    await putReport(context.env.OBJECTS, versionReportKey(versionKey), scan);
    return blocked(scan);
  }
  return storeScanned(context, publisher, versionKey, checked, scan, caps);
}

export async function withdraw(
  request: Request,
  key: VersionKey,
  context: Context,
): Promise<Response> {
  const db = context.env.MARKET;
  const authed = await authenticate(request, context, { sensitive: true });
  if (authed instanceof Response) return authed;
  const owner = await ownerOf(db, key.type, key.name);
  if (!owner) return failure(404, "not_found", "No such entry.");
  if (owner !== authed.publisher?.id) return notYours();
  const stored = await storedVersion(db, key);
  if (!stored || stored.state === "blocked") return failure(404, "not_found", "No such version.");
  const parsed = WithdrawRequest.safeParse(await readJson(request, 16 * 1024));
  if (!parsed.success) return failure(400, "invalid", "Say why the version is withdrawn.");
  const added = await addWithdrawal(db, {
    ...key,
    publisher: owner,
    hash: stored.hash,
    reason: parsed.data.reason,
    at: context.now,
  });
  if (!added) return notYours();
  return json({ status: "pending", ...key, hash: stored.hash }, 202);
}

/* ---------------------------------------------------------------- drafts */

const draftWrite = (
  id: string,
  publisher: string,
  key: VersionKey,
  checked: CheckedEntry,
  now: number,
) => ({
  id,
  publisher,
  type: key.type,
  name: key.name,
  version: key.version,
  hash: checked.hash,
  size: checked.size,
  files: checked.files.length,
  title: checked.listing.title,
  problems: checked.problems,
  now,
});

const noProfile = () => failure(409, "conflict", "Make your publisher profile before you publish.");
const noDraft = () => failure(404, "not_found", "No such draft.");

/** The draft's archive read and checked again from R2. */
async function draftChecked(context: Context, draft: DraftTable) {
  const stored = await context.env.OBJECTS.get(draftKey(draft.id));
  if (!stored) return undefined;
  return readChecked(draft.type, draft.name, new Uint8Array(await stored.arrayBuffer()));
}

/**
 * One more budgeted step of a draft's scan (ADR 0173 §8), from a request for the draft or the
 * cron. Every step is bound to the draft's hash: bytes that aren't the ones the row names (a
 * replace on its way) are left for later, and a step lands only while the draft still names the
 * bytes it read. Answers whether the scan is done now.
 */
export async function continueDraftScan(
  env: Context["env"],
  draft: DraftTable,
  publisher: { handle: string; official: boolean },
  now: number,
): Promise<boolean> {
  if (draft.scan_state === "done") return true;
  const db = env.MARKET;
  const job = await scanJob(db, draft.id);
  const stored = await env.OBJECTS.get(draftKey(draft.id));
  if (!job || !stored) return false;
  const checked = readChecked(draft.type, draft.name, new Uint8Array(await stored.arrayBuffer()));
  if (checked.hash !== draft.hash) {
    await deferJob(db, draft.id, now);
    return false;
  }
  const input = scanInput(
    draft.type,
    draft.name,
    checked,
    await scanContext(db, publisher, env.MARKET_PUBLIC_KEYS),
  );
  const step = scanWithin(input, job.state);
  if (!step.done) {
    await advanceJob(
      db,
      draft.id,
      draft.hash,
      { done: false, job: { cursor: step.state.cursor, files: job.files, state: step.state } },
      now,
    );
    return false;
  }
  const report = { ...step.report, hash: checked.hash };
  if (!(await advanceJob(db, draft.id, draft.hash, { done: true, verdict: report.verdict }, now)))
    return false;
  await putReport(env.OBJECTS, draftReportKey(draft.id), report);
  return true;
}

/**
 * Reads, checks, scans and stores a draft's archive, new or over an existing draft. The upload
 * is counted and the draft written only if each fits the limits in its own statement; the row
 * goes first, so bytes in R2 that the row doesn't name are never published or scanned as its.
 */
async function storeDraft(
  request: Request,
  context: Context,
  publisher: AuthedPublisher,
  key: VersionKey,
  id: string,
  existing: DraftTable | undefined,
): Promise<Response> {
  const db = context.env.MARKET;
  const body = await readCapped(request, maxArchiveBytes);
  if (!body) return failure(413, "too_large", `An archive is at most ${maxArchiveBytes} bytes.`);
  const refusal = await reserveUpload(db, {
    publisher: publisher.id,
    newPublisher: isNewPublisher(publisher, context.now),
    size: body.byteLength,
    newDraft: !existing,
    replacing: existing?.id,
    now: context.now,
  });
  if (refusal) return quota(refusal);
  const caps = capsOf(publisher, context.now);
  const checked = readChecked(key.type, key.name, body);
  const write = draftWrite(id, publisher.id, key, checked, context.now);
  let report: MarketScanReport | undefined;
  let written: boolean;
  if (checked.files.length === 0) {
    written = await writeDraft(db, write, { done: false, job: emptyJob() }, caps);
  } else {
    const input = scanInput(
      key.type,
      key.name,
      checked,
      await scanContext(
        db,
        { handle: publisher.name, official: publisher.official },
        context.env.MARKET_PUBLIC_KEYS,
      ),
    );
    const scanned = scanWithin(input);
    if (scanned.done) {
      report = { ...scanned.report, hash: checked.hash };
      written = await writeDraft(db, write, { done: true, verdict: report.verdict }, caps);
    } else {
      written = await writeDraft(
        db,
        write,
        {
          done: false,
          job: { cursor: scanned.state.cursor, files: checked.files.length, state: scanned.state },
        },
        caps,
      );
    }
  }
  if (!written) return quota(quotaRace);
  await context.env.OBJECTS.put(draftKey(id), body);
  if (report) await putReport(context.env.OBJECTS, draftReportKey(id), report);
  else await context.env.OBJECTS.delete(draftReportKey(id));
  const row = await readDraft(db, id);
  return row
    ? json(await draftBody(context.env.OBJECTS, db, row), existing ? 200 : 201)
    : noDraft();
}

/** An archive that didn't read has nothing to scan; its problems already block publishing. */
const emptyJob = () => ({
  cursor: 0,
  files: 0,
  state: { scanner: 1, cursor: 0, files: 0, textBytes: 0, findings: [], facts: {} },
});

/** `/v1/me/drafts…` (ADR 0173 §5). */
export async function draftRoute(
  request: Request,
  url: URL,
  route: Route,
  context: Context,
  authed: Authed,
): Promise<Response | undefined> {
  const db = context.env.MARKET;
  const publisher = authed.publisher;
  if (!route.kind.startsWith("me-draft")) return undefined;
  if (!publisher) return noProfile();
  if (route.kind === "me-draft-create") {
    const type = MarketEntryType.safeParse(url.searchParams.get("type")).data;
    const name = MarketEntryName.safeParse(url.searchParams.get("name")).data;
    const version = MarketVersion.safeParse(url.searchParams.get("version")).data;
    if (!type || !name || !version)
      return failure(400, "invalid", "Name the draft's type, name and version.");
    const owner = await ownerOf(db, type, name);
    if (owner !== undefined && owner !== publisher.id) return notYours();
    return storeDraft(
      request,
      context,
      publisher,
      { type, name, version },
      context.newId("drf"),
      undefined,
    );
  }
  if (!("id" in route)) return undefined;
  const draft = await readDraft(db, route.id);
  if (!draft || draft.publisher !== publisher.id) return noDraft();
  const who = { handle: publisher.name, official: publisher.official };
  switch (route.kind) {
    case "me-draft-read": {
      await continueDraftScan(context.env, draft, who, context.now);
      const row = (await readDraft(db, draft.id)) ?? draft;
      return json(await draftBody(context.env.OBJECTS, db, row));
    }
    case "me-draft-replace": {
      const version =
        MarketVersion.safeParse(url.searchParams.get("version")).data ?? draft.version;
      return storeDraft(
        request,
        context,
        publisher,
        { type: draft.type, name: draft.name, version },
        draft.id,
        draft,
      );
    }
    case "me-draft-patch": {
      const patch = MarketDraftPatch.safeParse(await readJson(request, 16 * 1024));
      if (!patch.success) return failure(400, "invalid", "That isn't a change to a draft.");
      await patchDraft(db, draft.id, patch.data, context.now);
      const row = (await readDraft(db, draft.id)) ?? draft;
      return json(await draftBody(context.env.OBJECTS, db, row));
    }
    case "me-draft-delete":
      await deleteDraft(db, context.env.OBJECTS, draft.id);
      return json({ status: "done" });
    case "me-draft-publish":
      return publishDraft(context, publisher, draft);
    default:
      return undefined;
  }
}

/**
 * Publishes a draft (ADR 0173 §5). The report, the bytes and the version are bound to the
 * draft's hash: the report must have scanned the hash the row names, the archive read again from
 * R2 must hash the same, and the version is stored only while the draft still names it.
 */
async function publishDraft(
  context: Context,
  publisher: AuthedPublisher,
  read: DraftTable,
): Promise<Response> {
  const db = context.env.MARKET;
  const who = { handle: publisher.name, official: publisher.official };
  if (!(await continueDraftScan(context.env, read, who, context.now)))
    return failure(409, "conflict", "The scan is still reading this draft; try again shortly.");
  const draft = await readDraft(db, read.id);
  if (!draft || draft.publisher !== publisher.id) return noDraft();
  if (draft.scan_state !== "done") return changed();
  const problems = JSON.parse(draft.problems) as { message: string }[];
  if (problems.length > 0) return refused(problems);
  const scan = await getReport(context.env.OBJECTS, draftReportKey(draft.id));
  if (!scan) return failure(409, "conflict", "The draft's scan is missing; upload it again.");
  if (scan.hash !== draft.hash) return changed();
  if (scan.verdict === "block") return blocked(scan);
  const key = { type: draft.type, name: draft.name, version: draft.version };
  const owner = await ownerOf(db, key.type, key.name);
  if (owner !== undefined && owner !== publisher.id) return notYours();
  const existing = await storedVersion(db, key);
  if (existing && existing.state !== "blocked")
    return existing.hash === draft.hash
      ? json({ status: "pending", ...key, hash: draft.hash }, 200)
      : reused();
  const checked = await draftChecked(context, draft);
  if (!checked) return failure(409, "conflict", "The draft's archive is missing; upload it again.");
  if (checked.hash !== draft.hash) return changed();
  if (checked.problems.length > 0) return refused(checked.problems);
  const guard = { quotaBytes: capsOf(publisher, context.now).quotaBytes, draft: draft.id };
  const answer = await storeScanned(context, publisher, key, checked, scan, guard, draft.changelog);
  if (answer.status === 201)
    await deletePublishedDraft(db, context.env.OBJECTS, draft.id, draft.hash);
  return answer;
}
