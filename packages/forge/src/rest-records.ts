import type { z } from "zod";
import type { ForgeCommit, ForgeFile } from "@ace/protocol/forge-browser";
import type { CommitRecord, FileRecord } from "./github-browser-schemas.ts";

/** A REST commit record as a listed commit; statistics come separately, when at all. */
export function restCommit(item: z.infer<typeof CommitRecord>): ForgeCommit {
  return {
    raw: item,
    sha: item.sha,
    message: item.commit.message,
    author: item.author?.login ?? item.commit.author?.name ?? "deleted user",
    ...(item.author?.avatar_url ? { authorAvatarUrl: item.author.avatar_url } : {}),
    date: item.commit.author?.date ?? null,
    url: item.html_url,
  };
}

/**
 * REST file records as changed files. A page carries at most 256 KB of patches; one that
 * doesn't fit is left out whole (never cut short), so the page diffs it from the file's content
 * when it is wanted.
 */
export function restFiles(records: readonly z.infer<typeof FileRecord>[]): ForgeFile[] {
  let remaining = 262_144;
  return records.map((file) => {
    const fits = file.patch !== undefined && file.patch.length <= remaining;
    const patch = fits ? (file.patch ?? null) : null;
    remaining -= patch?.length ?? 0;
    return {
      raw: Object.assign({}, file, { patch }),
      path: file.filename,
      ...(file.previous_filename === undefined ? {} : { previousPath: file.previous_filename }),
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch,
      truncated: patch === null,
    };
  });
}
