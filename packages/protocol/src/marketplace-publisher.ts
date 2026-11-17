import { z } from "zod";
import {
  MarketCategoryId,
  MarketEntryName,
  MarketEntryType,
  MarketHash,
  MarketProblem,
  MarketPublisherName,
  MarketVersion,
  trimmedText,
} from "./marketplace-base.ts";
import { MarketLink } from "./marketplace-catalog.ts";
import { MarketScanReport, MarketScanState } from "./marketplace-scan.ts";
import { MarketVerificationProof } from "./marketplace-signed.ts";

/*
 * Publishers on the wire (ADR 0174 §2 to §5, §7): public profiles, the signed-in publisher's own
 * page, drafts and every action a publisher takes on their publications, transfers, signals,
 * appeals and abuse reports. Every write needs a market grant; reports need none. Schema only.
 */

/* ---------------------------------------------------------------- profiles */

/** A handle a publisher picks now: 3 to 32, lowercase letters, digits and single dashes. */
export const MarketHandle = MarketPublisherName.refine((value) => value.length >= 3, {
  message: "A handle is at least 3 characters",
});
export const MarketDisplayName = trimmedText(1, 60);
export const MarketBio = z.string().max(500);
export const MarketPublisherState = z.enum(["active", "suspended", "deleted"]);
export type MarketPublisherState = z.infer<typeof MarketPublisherState>;
export const MarketEntryRef = z.strictObject({ type: MarketEntryType, name: MarketEntryName });
export type MarketEntryRef = z.infer<typeof MarketEntryRef>;

export const MarketProfile = z.strictObject({
  id: z.string().min(1).max(64),
  handle: MarketPublisherName,
  displayName: MarketDisplayName,
  bio: MarketBio,
  links: z.array(MarketLink).max(5),
  /** The picture's sha256, served at `/v1/avatars/{sha256}`. */
  avatar: MarketHash.optional(),
  joined: z.number().int().nonnegative(),
  /** Verified by ace's maintainers, on the signed verified list (ADR 0174 §13). */
  verified: z.boolean(),
  /** The proofs behind the mark: "Verified · owns example.com". */
  proofs: z.array(MarketVerificationProof).max(8),
  pins: z.array(MarketEntryRef).max(6),
});
export type MarketProfile = z.infer<typeof MarketProfile>;

/** `GET /v1/publishers/{handle}`. Entries are index entries, read as the index is. */
export const MarketPublisherBody = z.object({
  profile: MarketProfile,
  pinned: z.array(z.unknown()).max(6),
  entries: z.array(z.unknown()).max(500),
  downloads: z.number().int().nonnegative(),
});
export type MarketPublisherBody = z.infer<typeof MarketPublisherBody>;

/** `POST /v1/me/profile`: an authenticated account makes its profile. */
export const MarketProfileCreate = z.strictObject({
  handle: MarketHandle,
  displayName: MarketDisplayName,
  bio: MarketBio.default(""),
  links: z.array(MarketLink).max(5).default([]),
});
/** `PUT /v1/me/profile`: what the publisher changes; a verified profile needs a recent sign-in. */
export const MarketProfileEdit = z.strictObject({
  displayName: MarketDisplayName.optional(),
  bio: MarketBio.optional(),
  links: z.array(MarketLink).max(5).optional(),
});
/** `PUT /v1/me/handle`, a sensitive action. */
export const MarketHandleChange = z.strictObject({ handle: MarketHandle });
/** `PUT /v1/me/pins`: the publisher's own listed entries, in order. */
export const MarketPinsSet = z.strictObject({ entries: z.array(MarketEntryRef).max(6) });

/* ---------------------------------------------------------------- versions and entries */

/** A version as its publisher sees it (ADR 0174 §4). */
export const MarketVersionStatus = z.enum([
  "waiting",
  "live",
  "not-reviewed",
  "withdrawn",
  "blocked",
]);
export type MarketVersionStatus = z.infer<typeof MarketVersionStatus>;

export const MarketAppealState = z.enum(["open", "approved", "kept"]);
export const MarketAppeal = z.strictObject({
  id: z.string().regex(/^apl_[a-z0-9]{8,40}$/),
  note: z.string().max(2000),
  replacement: MarketVersion.optional(),
  at: z.number().int().nonnegative(),
  state: MarketAppealState,
  /** The maintainer's answer, once answered. */
  answer: z.string().max(2000).optional(),
});
export type MarketAppeal = z.infer<typeof MarketAppeal>;

export const MarketOwnVersion = z.strictObject({
  version: MarketVersion,
  hash: MarketHash,
  size: z.number().int().nonnegative(),
  published: z.number().int().nonnegative(),
  status: MarketVersionStatus,
  /** Waiting on a maintainer, not only on the signer. */
  held: z.boolean(),
  /** Why it is blocked or withdrawn, in plain words. */
  reason: z.string().max(500).optional(),
  deprecated: z.string().max(500).optional(),
  changelog: z.string().max(4000),
  downloads: z.number().int().nonnegative(),
  /** The scan as last run on these bytes; absent for versions from before scanning. */
  scan: MarketScanReport.optional(),
  appeal: MarketAppeal.optional(),
});
export type MarketOwnVersion = z.infer<typeof MarketOwnVersion>;

export const MarketVisibility = z.enum(["listed", "unlisted"]);
export type MarketVisibility = z.infer<typeof MarketVisibility>;

/** The words an entry is listed with, set by `market.json` or a listing edit. */
export const MarketListingEdit = z.strictObject({
  title: trimmedText(1, 120),
  line: trimmedText(0, 300),
  description: z.string().max(8192),
  categories: z.array(MarketCategoryId).max(3),
  keywords: z.array(trimmedText(1, 40)).max(16),
  links: z.array(MarketLink).max(5),
  /** Listing pictures uploaded with `PUT …/previews/{n}`, by sha256. */
  previews: z.array(MarketHash).max(4),
});
export type MarketListingEdit = z.infer<typeof MarketListingEdit>;

/** One of the publisher's entries, in the list on their page. */
export const MarketOwnEntrySummary = z.strictObject({
  type: MarketEntryType,
  name: MarketEntryName,
  title: z.string().min(1).max(120),
  line: z.string().max(300),
  /** The newest version and its status: what the row says. */
  version: MarketVersion.optional(),
  status: MarketVersionStatus.optional(),
  versions: z.number().int().nonnegative(),
  visibility: MarketVisibility,
  archived: z.boolean(),
  pinned: z.boolean(),
  reviewed: z.boolean(),
  downloads: z.number().int().nonnegative(),
  /** A listing edit waits for a maintainer. */
  pendingListing: z.boolean(),
  openReports: z.number().int().nonnegative(),
});
export type MarketOwnEntrySummary = z.infer<typeof MarketOwnEntrySummary>;

/** `GET /v1/me/entries/{type}/{name}`: everything about one of the publisher's entries. */
export const MarketOwnEntry = z.strictObject({
  summary: MarketOwnEntrySummary,
  listing: MarketListingEdit,
  /** The publisher's pick of the version the listing shows; absent means the newest live one. */
  latest: MarketVersion.optional(),
  /** A listing edit waiting for a maintainer, with its scan. */
  pendingListing: z
    .strictObject({ listing: MarketListingEdit, scan: MarketScanReport, at: z.number().int() })
    .optional(),
  versions: z.array(MarketOwnVersion).max(200),
});
export type MarketOwnEntry = z.infer<typeof MarketOwnEntry>;

/* ---------------------------------------------------------------- drafts */

export const MarketDraftId = z.string().regex(/^drf_[a-z0-9]{8,40}$/);
export const MarketDraft = z.strictObject({
  id: MarketDraftId,
  type: MarketEntryType,
  name: MarketEntryName,
  version: MarketVersion,
  hash: MarketHash,
  size: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  changelog: z.string().max(4000),
  /** The words its files list it with. */
  title: z.string().min(1).max(120),
  /** Format problems (ADR 0168 §7): a draft with any can't be published. */
  problems: z.array(MarketProblem).max(200),
  scan: MarketScanState,
});
export type MarketDraft = z.infer<typeof MarketDraft>;

/** `POST /v1/me/drafts?type=&name=&version=` takes the archive; `PATCH` changes its words. */
export const MarketDraftPatch = z.strictObject({
  version: MarketVersion.optional(),
  changelog: z.string().max(4000).optional(),
});

/* ---------------------------------------------------------------- actions on an entry */

export const MarketChangelogSet = z.strictObject({ text: z.string().max(4000) });
export const MarketLatestSet = z.strictObject({ version: MarketVersion.nullable() });
export const MarketDeprecation = z.strictObject({ note: trimmedText(1, 500) });
export const MarketWithdrawRequest = z.strictObject({ reason: trimmedText(1, 500) });
export const MarketVisibilitySet = z.strictObject({ visibility: MarketVisibility });
export const MarketArchivedSet = z.strictObject({ archived: z.boolean() });
export const MarketTransferOffer = z.strictObject({ to: MarketPublisherName });
export const MarketAppealRequest = z.strictObject({
  note: trimmedText(1, 2000),
  /** A newer version uploaded to answer the block or hold. */
  replacement: MarketVersion.optional(),
});

export const MarketTransferId = z.string().regex(/^trf_[a-z0-9]{8,40}$/);
export const MarketTransfer = z.strictObject({
  id: MarketTransferId,
  type: MarketEntryType,
  name: MarketEntryName,
  from: MarketPublisherName,
  to: MarketPublisherName,
  at: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  direction: z.enum(["incoming", "outgoing"]),
});
export type MarketTransfer = z.infer<typeof MarketTransfer>;

/* ---------------------------------------------------------------- verification */

/** `POST /v1/me/verification` (a recent sign-in): what the publisher wants to prove. */
export const MarketVerificationApply = z.strictObject({
  domain: MarketVerificationProof.options[1].shape.domain.optional(),
  github: MarketVerificationProof.options[2].shape.login.optional(),
});
export const MarketVerificationChallenge = z.strictObject({
  kind: z.enum(["domain", "github"]),
  /** The domain or GitHub login it proves. */
  subject: z.string().max(253),
  /** Random, single use: put it in the DNS TXT record, the well-known file, the gist or repo file. */
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: z.number().int().nonnegative(),
  /** Passed and spent, failed with why, or waiting for a check. */
  state: z.enum(["waiting", "passed", "failed"]),
  problem: z.string().max(500).optional(),
});
/** `GET /v1/me/verification`: the mark, the application and what a maintainer said. */
export const MarketVerificationStatus = z.strictObject({
  verified: z.boolean(),
  proofs: z.array(MarketVerificationProof).max(8),
  /** none | applied (waiting for a maintainer) | verified | revoked */
  state: z.enum(["none", "applied", "verified", "revoked"]),
  challenges: z.array(MarketVerificationChallenge).max(4),
  /** Why a maintainer revoked or refused it, shown to the publisher. */
  reason: z.string().max(500).optional(),
  /** A periodic re-check of a domain proof failed; maintainers look before anything changes. */
  flagged: z.string().max(500).optional(),
});
export type MarketVerificationStatus = z.infer<typeof MarketVerificationStatus>;

/* ---------------------------------------------------------------- your page */

export const MarketLimits = z.strictObject({
  uploadsToday: z.number().int().nonnegative(),
  uploadsPerDay: z.number().int().nonnegative(),
  storedBytes: z.number().int().nonnegative(),
  quotaBytes: z.number().int().nonnegative(),
  drafts: z.number().int().nonnegative(),
  draftLimit: z.number().int().nonnegative(),
});

/** `GET /v1/me`. Before the account makes a profile, only `state` and `limits` say anything. */
export const MarketMe = z.strictObject({
  profile: MarketProfile.optional(),
  state: MarketPublisherState,
  /** Stricter thresholds apply (ADR 0174 §9). */
  newPublisher: z.boolean(),
  limits: MarketLimits,
  entries: z.array(MarketOwnEntrySummary).max(500),
  drafts: z.array(MarketDraft).max(20),
  transfers: z.array(MarketTransfer).max(100),
});
export type MarketMe = z.infer<typeof MarketMe>;

/* ---------------------------------------------------------------- abuse reports */

export const MarketReportReason = z.enum([
  "malware",
  "harmful",
  "impersonation",
  "spam",
  "copyright",
  "other",
]);
export const MarketReportState = z.enum(["open", "dismissed", "kept", "withdrawn", "blocked"]);
/** `POST /v1/reports`: no account, no address kept. */
export const MarketReportRequest = z.strictObject({
  type: MarketEntryType,
  name: MarketEntryName,
  version: MarketVersion.optional(),
  reason: MarketReportReason,
  note: z.string().max(1000).default(""),
});
export type MarketReportRequest = z.infer<typeof MarketReportRequest>;

/* ---------------------------------------------------------------- signals */

/** `GET /v1/me/entries/{type}/{name}/signals`: anonymous totals for the publisher only. */
export const MarketSignals = z.strictObject({
  /** Days since the Unix epoch, oldest first, at most 90. */
  days: z.array(z.number().int().nonnegative()).max(90),
  versions: z
    .array(
      z.strictObject({
        version: MarketVersion,
        /** Downloads on each of `days`, in order. */
        downloads: z.array(z.number().int().nonnegative()).max(90),
      }),
    )
    .max(200),
  /** The share of the last 30 days' downloads on the latest version, 0 to 1. */
  adoption: z.strictObject({
    latest: MarketVersion.optional(),
    share: z.number().min(0).max(1),
    downloads: z.number().int().nonnegative(),
  }),
  reports: z
    .array(
      z.strictObject({
        reason: MarketReportReason,
        state: MarketReportState,
        at: z.number().int().nonnegative(),
      }),
    )
    .max(500),
});
export type MarketSignals = z.infer<typeof MarketSignals>;

/* ---------------------------------------------------------------- answers */

/** Why the market refused a request, in the API's one shape. */
export const MarketApiErrorCode = z.enum([
  "unauthorized",
  "reauth",
  "email_unverified",
  "suspended",
  "forbidden",
  "not_found",
  "invalid",
  "refused",
  "blocked",
  "conflict",
  "too_large",
  "quota",
  "busy",
  "unavailable",
  "method",
]);
export type MarketApiErrorCode = z.infer<typeof MarketApiErrorCode>;
export const MarketApiError = z.object({
  error: MarketApiErrorCode,
  message: z.string().max(2000),
  problems: z.array(MarketProblem).max(200).optional(),
  /** A block's scan, so the publisher sees every finding. */
  scan: MarketScanReport.optional(),
});
export type MarketApiError = z.infer<typeof MarketApiError>;

/** What a write that changes nothing else answers. */
export const MarketDone = z.object({ status: z.literal("done") });
