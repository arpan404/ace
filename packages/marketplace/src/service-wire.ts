import { z } from "zod";
import {
  MarketCategory,
  MarketEntryName,
  MarketEntryType,
  MarketHash,
  MarketProblem,
  MarketPublisher,
  MarketVersion,
} from "@ace/protocol/marketplace";
import { Signed } from "./signing.ts";

/*
 * The market Worker's publishing and signer routes (ADR 0168 §6, §7), shared by the Worker and
 * the tools that call it (`ace marketplace publish`, `ace market sign`). Read routes' bodies are
 * in feed.ts.
 *
 * Publishing (`Authorization: Bearer <market grant>`):
 * - `POST /v1/publish/{type}/{name}/versions?version=<v>[&publisher=<name>]`, the archive as the
 *   body (`application/x-tar`). `publisher` is needed on an account's first publish only.
 *   201 `PublishAccepted` (stored, waiting for the signer); 200 the same for the same bytes sent
 *   again; 422 `PublishRefused` (its problems, line by line; nothing stored or listed); 401 no
 *   or bad grant; 403 another publisher's entry; 409 the version number already names other
 *   bytes, or the publisher name is taken.
 * - `POST /v1/publish/{type}/{name}/versions/{version}/withdraw` with `WithdrawRequest`: 202, and
 *   the signer signs it into the withdrawn list.
 *
 * The signer (`Authorization: Bearer <signer token>`, a Worker secret; the signing key itself is
 * never on the Worker):
 * - `GET /v1/signer/pending` → `SignerPending`.
 * - `GET /v1/signer/objects/{hash}` → the archive of any stored version, listed or not.
 * - `PUT /v1/signer/versions/{type}/{name}/{version}` with `SignedVersionUpload`: the Worker
 *   checks the signature against its configured public keys and that the manifest names the
 *   stored version's type, name, version, publisher and hash; then the version is listed.
 * - `PUT /v1/signer/reviews/{type}/{name}/{version}` with `SignedReviewUpload`: a maintainer's
 *   review mark, signed by the signer (`ace market review`); only reviewed entries are featured
 *   or listed under categories.
 * - `PUT /v1/signer/withdrawn` with `SignedWithdrawnUpload`: the whole list, newest `issued`.
 * - `PUT /v1/signer/categories` with `CategoriesUpload`; `PUT /v1/signer/featured` with
 *   `FeaturedUpload` (reviewed entries only; others are refused with 422).
 */

export const PublishAccepted = z.object({
  status: z.literal("pending"),
  type: MarketEntryType,
  name: MarketEntryName,
  version: MarketVersion,
  hash: MarketHash,
});
export type PublishAccepted = z.infer<typeof PublishAccepted>;

export const PublishRefused = z.object({
  error: z.literal("refused"),
  problems: z.array(MarketProblem).max(200),
});
export type PublishRefused = z.infer<typeof PublishRefused>;

export const WithdrawRequest = z.object({ reason: z.string().trim().min(1).max(500) });

/** A stored version the signer hasn't signed yet. */
export const PendingVersion = z.object({
  type: MarketEntryType,
  name: MarketEntryName,
  version: MarketVersion,
  hash: MarketHash,
  publisher: MarketPublisher,
  size: z.number().int().nonnegative(),
  published: z.number().int().nonnegative(),
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
});
export type SignerPending = z.infer<typeof SignerPending>;

export const SignedVersionUpload = z.object({ manifest: Signed });
export const SignedReviewUpload = z.object({ review: Signed });
export const SignedWithdrawnUpload = z.object({ withdrawn: Signed });
export const CategoriesUpload = z.object({ categories: z.array(MarketCategory).max(32) });
export const FeaturedUpload = z.object({
  entries: z.array(z.object({ type: MarketEntryType, name: MarketEntryName })).max(24),
});
/** `GET /v1/search` on the Worker, for the web page and clients without the index. */
export const SearchBody = z.object({
  entries: z.array(z.unknown()).max(100),
  total: z.number().int().nonnegative(),
});
