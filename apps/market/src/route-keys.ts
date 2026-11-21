import {
  MarketDraftId,
  MarketEntryName,
  MarketEntryType,
  MarketHash,
  MarketPublisherName,
  MarketReportId,
  MarketTransferId,
  MarketVersion,
} from "@ace/protocol/marketplace";

/* The routes the market names, and the path segments that name them (routes.ts matches). */

export interface EntryKey {
  type: MarketEntryType;
  name: string;
}
export interface VersionKey extends EntryKey {
  version: string;
}

export type Route =
  // The catalog (ADR 0168 §3) and Discover (ADR 0174 §6): anyone.
  | { kind: "index" }
  | { kind: "search" }
  | { kind: "categories" }
  | { kind: "featured" }
  | { kind: "withdrawn" }
  | { kind: "blocklist" }
  | { kind: "verified" }
  | { kind: "official" }
  | { kind: "notices" }
  | { kind: "discover" }
  | ({ kind: "entry" } & EntryKey)
  | ({ kind: "version" } & VersionKey)
  | { kind: "object"; hash: string }
  | { kind: "publisher"; handle: string }
  | { kind: "avatar"; hash: string }
  | { kind: "preview"; hash: string }
  // Anonymous, rate-limited (ADR 0174 §7).
  | { kind: "report" }
  // Publishing with a market grant (ADR 0168 §7, ADR 0174 §2, §5).
  | ({ kind: "publish" } & EntryKey)
  | ({ kind: "withdraw" } & VersionKey)
  | { kind: "me" }
  | { kind: "me-profile-create" }
  | { kind: "me-profile-edit" }
  | { kind: "me-handle" }
  | { kind: "me-avatar" }
  | { kind: "me-pins" }
  | { kind: "me-verification" }
  | { kind: "me-verification-apply" }
  | { kind: "me-verification-check" }
  | { kind: "me-draft-create" }
  | { kind: "me-draft-read"; id: string }
  | { kind: "me-draft-replace"; id: string }
  | { kind: "me-draft-patch"; id: string }
  | { kind: "me-draft-delete"; id: string }
  | { kind: "me-draft-publish"; id: string }
  | ({ kind: "me-entry" } & EntryKey)
  | ({ kind: "me-entry-delete" } & EntryKey)
  | ({ kind: "me-listing" } & EntryKey)
  | ({ kind: "me-preview"; index: number } & EntryKey)
  | ({ kind: "me-latest" } & EntryKey)
  | ({ kind: "me-visibility" } & EntryKey)
  | ({ kind: "me-archived" } & EntryKey)
  | ({ kind: "me-entry-withdraw" } & EntryKey)
  | ({ kind: "me-transfer" } & EntryKey)
  | ({ kind: "me-signals" } & EntryKey)
  | ({ kind: "me-changelog" } & VersionKey)
  | ({ kind: "me-deprecate" } & VersionKey)
  | ({ kind: "me-undeprecate" } & VersionKey)
  | ({ kind: "me-version-withdraw" } & VersionKey)
  | ({ kind: "me-appeal" } & VersionKey)
  | { kind: "me-transfer-accept"; id: string }
  | { kind: "me-transfer-decline"; id: string }
  // The signer, behind its token (ADR 0168 §6, ADR 0174 §9, §10, §13).
  | { kind: "signer-pending" }
  | { kind: "signer-object"; hash: string }
  | ({ kind: "signer-version" } & VersionKey)
  | ({ kind: "signer-review" } & VersionKey)
  | { kind: "signer-withdrawn" }
  | { kind: "signer-categories" }
  | { kind: "signer-featured" }
  | { kind: "signer-queue" }
  | { kind: "signer-scan-context" }
  | ({ kind: "signer-hold" } & VersionKey)
  | ({ kind: "signer-block" } & VersionKey)
  | ({ kind: "signer-listing" } & EntryKey)
  | { kind: "signer-publisher"; handle: string }
  | { kind: "signer-publisher-read"; handle: string }
  | { kind: "signer-collections" }
  | { kind: "signer-blocklist" }
  | { kind: "signer-verified" }
  | { kind: "signer-official" }
  | { kind: "signer-notices" }
  | { kind: "signer-reports" }
  | { kind: "signer-report"; id: string }
  | { kind: "signer-appeal"; id: string };

export type Matched = { route: Route } | { refused: 404 | 405 };
/** The routes one path names, by method. */
export type Methods = Partial<Record<"GET" | "POST" | "PUT" | "PATCH" | "DELETE", Route>>;

export const type = (value: string | undefined) => MarketEntryType.safeParse(value).data;
export const name = (value: string | undefined) => MarketEntryName.safeParse(value).data;
export const version = (value: string | undefined) => MarketVersion.safeParse(value).data;
export const hash = (value: string | undefined) => MarketHash.safeParse(value).data;
export const handle = (value: string | undefined) => MarketPublisherName.safeParse(value).data;
export const draftId = (value: string | undefined) => MarketDraftId.safeParse(value).data;
export const transferId = (value: string | undefined) => MarketTransferId.safeParse(value).data;
export const reportId = (value: string | undefined) => MarketReportId.safeParse(value).data;
export const appealId = (value: string | undefined) =>
  value !== undefined && /^apl_[a-z0-9]{8,40}$/.test(value) ? value : undefined;

export function entryKey(
  typeSegment: string | undefined,
  nameSegment: string | undefined,
): EntryKey | undefined {
  const t = type(typeSegment);
  const n = name(nameSegment);
  return t && n ? { type: t, name: n } : undefined;
}
export function versionKey(
  typeSegment: string | undefined,
  nameSegment: string | undefined,
  versionSegment: string | undefined,
): VersionKey | undefined {
  const entry = entryKey(typeSegment, nameSegment);
  const v = version(versionSegment);
  return entry && v ? { ...entry, version: v } : undefined;
}

export const get = (route: Route): Methods => ({ GET: route });
export const post = (route: Route): Methods => ({ POST: route });
export const put = (route: Route): Methods => ({ PUT: route });

export const patch = (route: Route): Methods => ({ PATCH: route });
export const del = (route: Route): Methods => ({ DELETE: route });
