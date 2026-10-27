import { z } from "zod";
import { formatBytes } from "./byte-size.ts";
import { pathParts } from "./checkout-files.ts";
import { checkoutError } from "./checkout-errors.ts";

/*
 * Folder downloads and uploads for every client's Files tool, pure: the daemon's archive preview
 * read leniently, what it says to the person (count, size, what stays out), what a failed
 * archive download says, and the name a "keep both" upload takes beside a file already there.
 */

/** The `files.result` of an `archive.preview`; unknown fields are kept. */
export const ArchivePreview = z.looseObject({
  previewId: z.string().min(1),
  entries: z.number().int().nonnegative(),
  bytes: z.number().nonnegative(),
});
export type ArchivePreview = z.infer<typeof ArchivePreview>;

/** The archive's file name: the folder's name (or "checkout" for the root) with `.tar.gz`. */
export function archiveName(folder: string): string {
  return `${pathParts(folder.replace(/\/+$/, "")).name || "checkout"}.tar.gz`;
}

/** "128 entries · 4.2 MB before compression". */
export function archiveSummary(preview: Pick<ArchivePreview, "entries" | "bytes">): string {
  const entries = preview.entries === 1 ? "1 entry" : `${preview.entries} entries`;
  return `${entries} · ${formatBytes(preview.bytes)} before compression`;
}

/** What the daemon's archive always leaves out, and ignored files unless asked for. */
export function archiveLeavesOut(includeIgnored: boolean): string {
  return includeIgnored
    ? "Leaves out .git and links."
    : "Leaves out .git, links and files Git ignores.";
}

/** A failed archive download as one sentence: a stale preview says to choose it again. */
export function archiveFailure(error: unknown): { code: string; message: string } {
  const issue = checkoutError(error);
  if (issue.code === "EXPIRED" || issue.code === "CONFLICT" || issue.code === "NOT_FOUND")
    return {
      code: issue.code,
      message: "The folder changed or this preview expired. Choose Download folder again.",
    };
  return { code: issue.code, message: issue.message };
}

/**
 * Where a "keep both" upload may go, in order: `path` with " 2" (then " 3", …) before its
 * extension. "notes.md" → "notes 2.md"; ".env" → ".env 2". Endless; take the first that's free.
 */
export function* keepBothPaths(path: string): Generator<string, never> {
  const { folder, name } = pathParts(path);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  const prefix = folder ? `${folder}/` : "";
  for (let copy = 2; ; copy++) yield `${prefix}${stem} ${copy}${extension}`;
}

/** The first "keep both" path that `taken` doesn't hold. */
export function keepBothPath(path: string, taken: (path: string) => boolean): string {
  for (const candidate of keepBothPaths(path)) if (!taken(candidate)) return candidate;
  throw new Error("unreachable");
}
