import { z } from "zod";
import {
  MarketEntryName,
  MarketEntryType,
  MarketEntrySummary,
  MarketPublisherName,
  MarketVersion,
} from "./marketplace-base.ts";
import {
  MarketCollectionId,
  MarketTopPublisher,
  MarketTrendMovement,
} from "./marketplace-discover.ts";
import {
  MarketAppealRequest,
  MarketDraft,
  MarketDraftId,
  MarketHandle,
  MarketListingEdit,
  MarketMe,
  MarketOwnEntry,
  MarketProfile,
  MarketProfileCreate,
  MarketProfileEdit,
  MarketReportReason,
  MarketSignals,
  MarketTransferId,
  MarketVisibility,
  MarketEntryRef,
} from "./marketplace-publisher.ts";

/*
 * Publishing and Discover through the daemon (ADR 0173 §2, §11): what `marketplace.request`
 * carries for the app. `publish` needs the admin scope and mints a market grant through the
 * machine's signed-in ace account for each request; signed out, it answers `signed_out`.
 * `discover` and `publisher` are reads. Schema only.
 */

const entry = { type: MarketEntryType, name: MarketEntryName };
const versionKey = { ...entry, version: MarketVersion };
/** A picture as base64, at most 1 MiB of bytes. */
const Image = z.string().max(1_400_000);

/** Where a draft's files come from: a folder on this machine, or an archive the app made. */
export const MarketDraftSource = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("folder"), path: z.string().min(1).max(4096) }),
  /** Base64 of the folder's tar archive, at most 6 MB. */
  z.strictObject({ kind: z.literal("archive"), archive: z.string().max(8_000_000) }),
]);
export type MarketDraftSource = z.infer<typeof MarketDraftSource>;

export const MarketPublishAction = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("me") }),
  z.strictObject({ action: z.literal("entry"), ...entry }),
  z.strictObject({ action: z.literal("createProfile"), profile: MarketProfileCreate }),
  z.strictObject({ action: z.literal("editProfile"), profile: MarketProfileEdit }),
  z.strictObject({ action: z.literal("changeHandle"), handle: MarketHandle }),
  z.strictObject({ action: z.literal("setAvatar"), image: Image }),
  z.strictObject({ action: z.literal("setPins"), entries: z.array(MarketEntryRef).max(6) }),
  z.strictObject({
    action: z.literal("draftCreate"),
    ...versionKey,
    source: MarketDraftSource,
    changelog: z.string().max(4000).optional(),
  }),
  z.strictObject({ action: z.literal("draftRead"), id: MarketDraftId }),
  z.strictObject({
    action: z.literal("draftUpdate"),
    id: MarketDraftId,
    version: MarketVersion.optional(),
    changelog: z.string().max(4000).optional(),
    /** New files for the draft, scanned again. */
    source: MarketDraftSource.optional(),
  }),
  z.strictObject({ action: z.literal("draftDelete"), id: MarketDraftId }),
  z.strictObject({ action: z.literal("draftPublish"), id: MarketDraftId }),
  z.strictObject({ action: z.literal("listing"), ...entry, listing: MarketListingEdit }),
  z.strictObject({
    action: z.literal("preview"),
    ...entry,
    index: z.number().int().min(0).max(3),
    image: Image,
  }),
  z.strictObject({
    action: z.literal("changelog"),
    ...versionKey,
    text: z.string().max(4000),
  }),
  z.strictObject({ action: z.literal("latest"), ...entry, version: MarketVersion.nullable() }),
  z.strictObject({
    action: z.literal("deprecate"),
    ...versionKey,
    /** Null clears the deprecation. */
    note: z.string().trim().min(1).max(500).nullable(),
  }),
  z.strictObject({
    action: z.literal("withdraw"),
    ...entry,
    /** Absent withdraws every live version of the entry. */
    version: MarketVersion.optional(),
    reason: z.string().trim().min(1).max(500),
  }),
  z.strictObject({ action: z.literal("deleteEntry"), ...entry }),
  z.strictObject({ action: z.literal("visibility"), ...entry, visibility: MarketVisibility }),
  z.strictObject({ action: z.literal("archive"), ...entry, archived: z.boolean() }),
  z.strictObject({ action: z.literal("transfer"), ...entry, to: MarketPublisherName }),
  z.strictObject({
    action: z.literal("transferAnswer"),
    id: MarketTransferId,
    accept: z.boolean(),
  }),
  z.strictObject({ action: z.literal("signals"), ...entry }),
  z.strictObject({
    action: z.literal("appeal"),
    ...versionKey,
    ...MarketAppealRequest.shape,
  }),
]);
export type MarketPublishAction = z.infer<typeof MarketPublishAction>;

/** What a `publish` action answers. */
export const MarketPublishAnswer = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("me"), me: MarketMe }),
  z.strictObject({ kind: z.literal("entry"), entry: MarketOwnEntry }),
  z.strictObject({ kind: z.literal("profile"), profile: MarketProfile }),
  z.strictObject({ kind: z.literal("draft"), draft: MarketDraft }),
  z.strictObject({ kind: z.literal("signals"), signals: MarketSignals }),
  /** A version stored and waiting; `held` when a maintainer must look first. */
  z.strictObject({
    kind: z.literal("published"),
    ...versionKey,
    held: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("done") }),
]);
export type MarketPublishAnswer = z.infer<typeof MarketPublishAnswer>;

/** Discover as the daemon answers it, with entries read into summaries. */
export const MarketDiscover = z.strictObject({
  hero: MarketEntrySummary.optional(),
  featured: z.array(MarketEntrySummary).max(24),
  trending: z
    .array(
      z.strictObject({
        entry: MarketEntrySummary,
        rank: z.number().int().positive(),
        movement: MarketTrendMovement,
        week: z.number().int().nonnegative(),
      }),
    )
    .max(50),
  fresh: z.array(MarketEntrySummary).max(24),
  collections: z
    .array(
      z.strictObject({
        id: MarketCollectionId,
        title: z.string().max(60),
        line: z.string().max(200),
        entries: z.array(MarketEntrySummary).max(24),
      }),
    )
    .max(16),
  publishers: z.array(MarketTopPublisher).max(12),
  rankedAt: z.number().int().nonnegative(),
  /** When the daemon read it; it keeps the last answer for offline. */
  readAt: z.number().int().nonnegative(),
});
export type MarketDiscover = z.infer<typeof MarketDiscover>;

export const MarketPublisherPage = z.strictObject({
  profile: MarketProfile,
  pinned: z.array(MarketEntrySummary).max(6),
  entries: z.array(MarketEntrySummary).max(500),
  downloads: z.number().int().nonnegative(),
});
export type MarketPublisherPage = z.infer<typeof MarketPublisherPage>;

/** The ops `marketplace.request` gains (ADR 0173 §11). */
export const marketPublishOperations = [
  z.strictObject({ op: z.literal("discover") }),
  z.strictObject({ op: z.literal("publisher"), handle: MarketPublisherName }),
  z.strictObject({ op: z.literal("publish"), request: MarketPublishAction }),
  z.strictObject({
    op: z.literal("report"),
    ...entry,
    version: MarketVersion.optional(),
    reason: MarketReportReason,
    note: z.string().max(1000).default(""),
  }),
] as const;

export const marketPublishResults = [
  z.strictObject({ op: z.literal("discover"), discover: MarketDiscover }),
  z.strictObject({ op: z.literal("publisher"), page: MarketPublisherPage }),
  z.strictObject({ op: z.literal("publish"), answer: MarketPublishAnswer }),
] as const;
