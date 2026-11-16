import { z } from "zod";
import {
  MarketCategory,
  MarketEntryName,
  MarketEntryType,
  MarketHash,
  MarketProblem,
  MarketPublisher,
  MarketPublisherName,
  MarketVersion,
} from "./marketplace-base.ts";
import { MarketCollection } from "./marketplace-discover.ts";
import {
  MarketAppeal,
  MarketListingEdit,
  MarketPublisherState,
  MarketReportReason,
  MarketReportState,
} from "./marketplace-publisher.ts";
import { MarketScanReport } from "./marketplace-scan.ts";
import { MarketVerificationProof, Signed } from "./marketplace-signed.ts";

/*
 * The market Worker's publishing and signer routes (ADR 0168 §6, §7; ADR 0173 §9, §10), shared
 * by the Worker and the tools that call it (`ace marketplace publish`, `ace market …`).
 * Publisher routes under `/v1/me` are in marketplace-publisher.ts; read bodies in
 * marketplace-catalog.ts and marketplace-discover.ts. Schema only.
 *
 * Publishing (`Authorization: Bearer <market grant>`):
 * - `POST /v1/publish/{type}/{name}/versions?version=<v>[&publisher=<handle>]`, the archive as
 *   the body. `publisher` is needed on an account's first publish only. 201 `PublishAccepted`
 *   (stored, waiting); 200 the same for the same bytes again; 422 `PublishRefused` (format
 *   problems, nothing stored) or a scan block (`error: "blocked"`, the version recorded as
 *   blocked with its report); 401 no or bad grant; 403 another publisher's entry or a suspended
 *   account; 409 the version number already names other bytes, or the handle is taken.
 * - `POST /v1/publish/{type}/{name}/versions/{version}/withdraw` with a reason: 202.
 *
 * The signer (`Authorization: Bearer <signer token>`, a Worker secret; the key is never there):
 * see the routes below each body.
 */

export const PublishAccepted = z.object({
  status: z.literal("pending"),
  type: MarketEntryType,
  name: MarketEntryName,
  version: MarketVersion,
  hash: MarketHash,
  /** Held for a maintainer rather than waiting only for the signer (ADR 0173 §9). */
  held: z.boolean().optional(),
  scan: MarketScanReport.optional(),
});
export type PublishAccepted = z.infer<typeof PublishAccepted>;

export const PublishRefused = z.object({
  error: z.literal("refused"),
  problems: z.array(MarketProblem).max(200),
});
export type PublishRefused = z.infer<typeof PublishRefused>;

export const WithdrawRequest = z.object({ reason: z.string().trim().min(1).max(500) });

/** A stored version the signer hasn't signed yet (`GET /v1/signer/pending`). */
export const PendingVersion = z.object({
  type: MarketEntryType,
  name: MarketEntryName,
  version: MarketVersion,
  hash: MarketHash,
  publisher: MarketPublisher,
  size: z.number().int().nonnegative(),
  published: z.number().int().nonnegative(),
  /** A maintainer released it from a hold: its warns are answered, never its blocks. */
  approved: z.boolean().optional(),
});
export type PendingVersion = z.infer<typeof PendingVersion>;

export const PendingWithdrawal = z.object({
  type: MarketEntryType,
  name: MarketEntryName,
  version: MarketVersion,
  hash: MarketHash,
  reason: z.string().max(500),
  at: z.number().int().nonnegative(),
});
export type PendingWithdrawal = z.infer<typeof PendingWithdrawal>;

export const SignerPending = z.object({
  versions: z.array(PendingVersion).max(500),
  withdrawals: z.array(PendingWithdrawal).max(500),
  /** The withdrawn list as last signed, so the signer adds to it rather than starting over. */
  withdrawn: Signed.optional(),
  /** The blocklist as last signed. */
  blocklist: Signed.optional(),
  /** The verified list as last signed. */
  verified: Signed.optional(),
  /** The official list as last signed. */
  official: Signed.optional(),
});
export type SignerPending = z.infer<typeof SignerPending>;

export const SignedVersionUpload = z.object({ manifest: Signed });
export const SignedReviewUpload = z.object({ review: Signed });
export const SignedWithdrawnUpload = z.object({ withdrawn: Signed });
/** `PUT /v1/signer/blocklist`. */
export const SignedBlocklistUpload = z.object({ blocklist: Signed });
export const CategoriesUpload = z.object({ categories: z.array(MarketCategory).max(32) });
export const FeaturedUpload = z.object({
  entries: z.array(z.object({ type: MarketEntryType, name: MarketEntryName })).max(24),
});
/** `PUT /v1/signer/collections`: the whole list, in order. */
export const CollectionsUpload = z.object({ collections: z.array(MarketCollection).max(16) });

/** `PUT /v1/signer/official`: the whole signed official list (ADR 0173 §14). */
export const SignedOfficialUpload = z.object({ official: Signed });

/* ---------------------------------------------------------------- the scan's context */

/**
 * `GET /v1/signer/scan-context`: what the scanner compares names and handles against
 * (typosquats, impersonation), as the signer runs it. The device builds the same from its index.
 */
export const MarketScanContextBody = z.object({
  entries: z
    .array(
      z.object({
        type: z.string().max(40),
        name: MarketEntryName,
        publisher: MarketPublisherName,
        downloads: z.number().int().nonnegative(),
      }),
    )
    .max(50_000),
  verified: z
    .array(z.object({ handle: MarketPublisherName, displayName: z.string().max(60) }))
    .max(5_000),
  /** Publishers with stricter thresholds (ADR 0173 §9), by handle. */
  newPublishers: z.array(MarketPublisherName).max(50_000),
});
export type MarketScanContextBody = z.infer<typeof MarketScanContextBody>;

/* ---------------------------------------------------------------- the maintainers' queue */

/** `GET /v1/signer/queue`: what waits for a maintainer (ADR 0173 §9). */
export const MarketQueueBody = z.object({
  held: z
    .array(
      z.object({
        type: MarketEntryType,
        name: MarketEntryName,
        version: MarketVersion,
        hash: MarketHash,
        publisher: MarketPublisher,
        newPublisher: z.boolean(),
        published: z.number().int().nonnegative(),
        scan: MarketScanReport.optional(),
      }),
    )
    .max(500),
  listings: z
    .array(
      z.object({
        type: MarketEntryType,
        name: MarketEntryName,
        publisher: MarketPublisher,
        listing: MarketListingEdit,
        scan: MarketScanReport,
        at: z.number().int().nonnegative(),
      }),
    )
    .max(500),
  verifications: z
    .array(
      z.object({
        publisher: MarketPublisher,
        /** Proofs passed so far, the account's always among them. */
        proofs: z.array(MarketVerificationProof).max(8),
        at: z.number().int().nonnegative(),
        /** A re-check of a verified publisher's domain failed, with why. */
        flagged: z.string().max(500).optional(),
      }),
    )
    .max(500),
  appeals: z
    .array(
      MarketAppeal.extend({
        type: MarketEntryType,
        name: MarketEntryName,
        version: MarketVersion,
        publisher: MarketPublisher,
        status: z.enum(["blocked", "held"]),
        reason: z.string().max(500).optional(),
      }),
    )
    .max(500),
});
export type MarketQueueBody = z.infer<typeof MarketQueueBody>;

/** `PUT /v1/signer/holds/{type}/{name}/{version}`: release a hold (the signer signs next). */
export const HoldDecision = z.object({
  decision: z.enum(["approve", "hold"]),
  note: z.string().max(500).optional(),
});
/** `PUT /v1/signer/blocks/{type}/{name}/{version}`: refuse a version, by scan or by hand. */
export const BlockDecision = z.object({
  reason: z.string().trim().min(1).max(500),
  scan: MarketScanReport.optional(),
});
/** `PUT /v1/signer/listings/{type}/{name}`: a pending listing edit approved or refused. */
export const ListingDecision = z.object({
  decision: z.enum(["approve", "refuse"]),
  reason: z.string().max(500).optional(),
});
/** `PUT /v1/signer/publishers/{handle}`: suspend or restore. Verification is the signed list. */
export const PublisherDecision = z.object({
  state: MarketPublisherState,
  reason: z.string().max(500).optional(),
});
/**
 * `PUT /v1/signer/verified`: the whole signed verified list, and for a publisher just taken off
 * it the reason they see.
 */
export const SignedVerifiedUpload = z.object({
  verified: Signed,
  revoked: z
    .array(z.object({ handle: MarketPublisherName, reason: z.string().trim().min(1).max(500) }))
    .max(100)
    .default([]),
});
/** `PUT /v1/signer/appeals/{id}`. */
export const AppealAnswer = z.object({
  answer: z.string().trim().min(1).max(2000),
  decision: z.enum(["approve", "keep"]),
});

/** `GET /v1/signer/publishers/{handle}`: what `--withdraw-all` needs to revoke. */
export const PublisherVersionsBody = z.object({
  publisher: MarketPublisher,
  state: MarketPublisherState,
  live: z
    .array(
      z.object({
        type: MarketEntryType,
        name: MarketEntryName,
        version: MarketVersion,
        hash: MarketHash,
      }),
    )
    .max(10_000),
});

/* ---------------------------------------------------------------- reports */

export const MarketReportId = z.string().regex(/^rpt_[a-z0-9]{8,40}$/);
/** `GET /v1/signer/reports`: open reports first, newest first. */
export const MarketReportsBody = z.object({
  reports: z
    .array(
      z.object({
        id: MarketReportId,
        type: MarketEntryType,
        name: MarketEntryName,
        version: MarketVersion.optional(),
        reason: MarketReportReason,
        note: z.string().max(1000),
        at: z.number().int().nonnegative(),
        state: MarketReportState,
        outcome: z.string().max(500).optional(),
      }),
    )
    .max(500),
});
export type MarketReportsBody = z.infer<typeof MarketReportsBody>;
/** `PUT /v1/signer/reports/{id}`. */
export const ReportResolution = z.object({
  state: MarketReportState.exclude(["open"]),
  note: z.string().max(500).optional(),
});
