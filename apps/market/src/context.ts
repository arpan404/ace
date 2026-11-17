import type { Env } from "./env.ts";
import type { KeySource } from "./grant-keys.ts";
import type { Databases } from "./store/databases.ts";

/** What a handler gets besides the request: bindings, and what the shell injects. */
export interface Context {
  env: Env;
  /** The D1 databases, by entry type or domain (ADR 0174 §16). */
  dbs: Databases;
  /** The request's time, from the shell's clock. */
  now: number;
  /** Work that finishes after the response, such as a download count. */
  waitUntil(promise: Promise<unknown>): void;
  /** The account backend's grant keys. */
  grantKeys: KeySource;
  /** A fresh id with its prefix (`pub`, `drf`, `trf`, `apl`, `rpt`): 24 random hex digits. */
  newId(prefix: IdPrefix): string;
  /** A fresh proof token (ADR 0174 §13): 32 random bytes as base64url. */
  newToken(): string;
  /** Fetch for proof checks (ADR 0174 §13) only; everything else is a binding. */
  fetch(url: string, init: RequestInit): Promise<Response>;
}

export type IdPrefix = "pub" | "drf" | "trf" | "apl" | "rpt";

/** An archive's place in R2. */
export const objectKey = (hash: string) => `objects/${hash}`;
/**
 * A draft's archive, one object per revision: keyed by the content hash the draft's row names,
 * so the row always points at the bytes it describes, whatever order two replaces land in.
 */
export const draftKey = (id: string, hash: string) => `${draftPrefix(id)}${hash || "none"}`;
export const draftPrefix = (id: string) => `drafts/${id}/`;
/** Pictures, by the sha256 of their stripped bytes. */
export const avatarKey = (sha256: string) => `avatars/${sha256}`;
export const previewKey = (sha256: string) => `previews/${sha256}`;
/** Scan reports (ADR 0174 §8). */
export const draftReportKey = (id: string, hash: string) =>
  `${draftReportPrefix(id)}${hash || "none"}.json`;
export const draftReportPrefix = (id: string) => `reports/drafts/${id}/`;
export const versionReportKey = (key: { type: string; name: string; version: string }) =>
  `reports/versions/${key.type}/${key.name}/${key.version}.json`;
export const listingReportKey = (key: { type: string; name: string }) =>
  `reports/listings/${key.type}/${key.name}.json`;
