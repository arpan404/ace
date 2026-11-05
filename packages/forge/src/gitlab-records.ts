import { z } from "zod";
import { ForgePrRef, type ForgeRepository } from "@ace/protocol/forge";
import { ForgePrFiles, ForgePrSearch } from "@ace/protocol/forge-browser";
import { ForgeError } from "./errors.ts";
import { redactData } from "./redact.ts";

export const sha = z.string().regex(/^[a-fA-F0-9]{40,64}$/);
const isoText = z.string().min(1).max(65_536);

/** GitLab merge request as GET /projects/:id/merge_requests[:/iid] reports it.
 * docs.gitlab.com/api/merge_requests/; unknown fields stay via passthrough. */
export const Mr = z
  .object({
    iid: z.number().int().positive(),
    title: z.string().max(65_536),
    description: z.string().nullable().optional(),
    state: z.string().max(32),
    draft: z.boolean().optional(),
    work_in_progress: z.boolean().optional(),
    updated_at: isoText,
    created_at: isoText.optional(),
    sha: z.string().max(256).optional(),
    source_branch: z.string().max(1024).optional(),
    target_branch: z.string().max(1024).optional(),
    author: z
      .looseObject({ username: z.string().optional(), name: z.string().optional() })
      .optional(),
    labels: z.array(z.string()).max(100).optional(),
    user_notes_count: z.number().int().nonnegative().optional(),
    diff_refs: z
      .looseObject({
        base_sha: z.string().max(256).optional(),
        head_sha: z.string().max(256).optional(),
        start_sha: z.string().max(256).optional(),
      })
      .optional(),
    has_conflicts: z.boolean().optional(),
    detailed_merge_status: z.string().max(100).optional(),
    source_project_id: z.number().int().optional(),
    target_project_id: z.number().int().optional(),
    project_id: z.number().int().optional(),
  })
  .passthrough();
export const MrList = z.array(Mr).max(100);
const Change = z
  .object({
    old_path: z.string().max(65_536),
    new_path: z.string().max(65_536),
    new_file: z.boolean().optional(),
    deleted_file: z.boolean().optional(),
    renamed_file: z.boolean().optional(),
    diff: z.string(),
  })
  .passthrough();
/** `overflow` marks a diff GitLab itself cut short: never read it as complete. */
export const Changes = z
  .looseObject({
    changes: z.array(Change),
    overflow: z.boolean().optional(),
    diff_refs: Mr.shape.diff_refs,
  })
  .passthrough();
export const SourceProject = z
  .looseObject({ path_with_namespace: z.string().max(512) })
  .passthrough();
export type GitLabMr = z.infer<typeof Mr>;
/** Pinned head/base (plus unsupported commit/since) for file reads; module-level, never per call. */
export const PinnedShas = ForgePrFiles.pick({
  headSha: true,
  baseSha: true,
  commit: true,
  since: true,
});
export type Headers = Record<string, string>;

export function splitHttp(stdout: string): { headers: Headers; body: string } {
  const split = /\r?\n\r?\n/.exec(stdout);
  if (!split) throw new ForgeError("cli");
  const headers: Headers = {};
  for (const line of stdout.slice(0, split.index).split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { headers, body: stdout.slice(split.index + split[0].length) };
}

/** A merge request's state as GitLab reports it. Future states stay `unknown`:
 * never projected open, so a new state can't pose as reviewable. */
export function statusState(mr: GitLabMr): "open" | "draft" | "closed" | "merged" | "unknown" {
  const s = mr.state.toLowerCase();
  if (s === "merged") return "merged";
  if (s === "closed") return "closed";
  if (s === "opened") return mr.draft === true || mr.work_in_progress === true ? "draft" : "open";
  return "unknown";
}

/** List rows cannot express `unknown`: a future state rejects the read outright. */
export function rowState(mr: GitLabMr): "open" | "draft" | "closed" | "merged" {
  const state = statusState(mr);
  if (state === "unknown") throw new ForgeError("unsupported");
  return state;
}

/** Output schemas are ours, but a throw must still be a sanitized ForgeError. */
export function must<T>(result: { success: boolean; data?: T }): T {
  if (!result.success || result.data === undefined) throw new ForgeError("invalid_data");
  return result.data;
}

export function headOf(mr: GitLabMr): string {
  return mr.diff_refs?.head_sha ?? mr.sha ?? "";
}

/** A missing or malformed head SHA is unreadable data, never a zeroed stand-in. */
export function requireSha(value: string): string {
  if (!sha.safeParse(value).success) throw new ForgeError("invalid_data");
  return value;
}

/**
 * The MR's canonical web URL, built from the repository under read — never the
 * server's `web_url`, which may name another host or carry credentials.
 */
export function canonicalMrUrl(repository: ForgeRepository, iid: number): string {
  return `https://${repository.host}/${repository.owner}/${repository.name}/-/merge_requests/${iid}`;
}

/** HTTP status to ForgeError; quota evidence distinguishes rate limits from denials. */
export function throwForStatus(code: number, headers: Headers, cliCode: number | null): void {
  if (
    code === 429 ||
    (code === 403 &&
      (headers["retry-after"] !== undefined || headers["x-ratelimit-remaining"] === "0"))
  )
    throw new ForgeError("rate_limit");
  if (code === 401 || code === 403) throw new ForgeError("forbidden");
  if (code === 404) throw new ForgeError("not_found");
  if (code < 200 || code >= 300 || cliCode !== 0) throw new ForgeError("cli");
}

export type StateCounts = { open: number; draft: number; closed: number; merged: number };

function countedTotal(state: ForgePrSearch["state"], counts: StateCounts): number {
  if (state === "open") return counts.open;
  if (state === "draft") return counts.draft;
  if (state === "closed") return counts.closed;
  if (state === "merged") return counts.merged;
  if (state === "active") return Math.min(counts.open + counts.draft, 1000);
  return Math.min(counts.open + counts.draft + counts.closed + counts.merged, 1000);
}

/**
 * A list page's total and cursor. The page's own x-total already matches the
 * filter; without it the known rows are a lower bound, never a zero total.
 * Any capped count forces incomplete, even beside a valid page total.
 */
export function listTotals(input: {
  state: ForgePrSearch["state"];
  page: number;
  rowCount: number;
  headers: Headers;
  counts: StateCounts & { capped: boolean };
}): { total: number; nextPage?: number; incomplete: boolean; truncated: boolean } {
  const pageTotal = Number(input.headers["x-total"]);
  const pageKnown = Number.isInteger(pageTotal) && pageTotal >= 0;
  const lowerBound = (input.page - 1) * 25 + input.rowCount;
  const total = pageKnown
    ? pageTotal
    : Math.max(countedTotal(input.state, input.counts), lowerBound);
  const nextHeader = input.headers["x-next-page"]?.trim();
  const nextPage =
    nextHeader !== undefined
      ? nextHeader === ""
        ? undefined
        : input.page + 1
      : pageKnown
        ? input.page * 25 < Math.min(total, 1000)
          ? input.page + 1
          : undefined
        : input.rowCount === 25
          ? input.page + 1
          : undefined;
  return {
    total,
    ...(nextPage !== undefined ? { nextPage } : {}),
    incomplete: !pageKnown || input.counts.capped,
    truncated: total > 1000,
  };
}

/** One list row; a missing head is invalid data, never an omitted pin. */
export function prRow(repository: ForgeRepository, item: GitLabMr): object {
  return Object.assign(
    {
      raw: redactData(item),
      ref: ForgePrRef.parse({ repository, number: item.iid }),
      title: item.title,
      url: canonicalMrUrl(repository, item.iid),
      author: item.author?.username ?? item.author?.name ?? "deleted user",
      state: rowState(item),
      labels: (item.labels ?? []).slice(0, 100),
      updatedAt: item.updated_at,
      headSha: requireSha(headOf(item)),
    },
    item.created_at ? { createdAt: item.created_at } : null,
    item.user_notes_count !== undefined ? { commentCount: item.user_notes_count } : null,
    item.source_branch ? { headBranch: item.source_branch } : null,
    item.target_branch ? { baseBranch: item.target_branch } : null,
  );
}

/** One changed file; over-long patches are cut and flagged, never dropped. */
export function changeFile(
  c: z.infer<typeof Changes>["changes"][number],
): { truncated: boolean } & object {
  let added = 0;
  let removed = 0;
  for (const line of c.diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return Object.assign(
    {
      raw: redactData(c),
      path: c.new_path,
      status:
        c.new_file === true
          ? "added"
          : c.deleted_file === true
            ? "removed"
            : c.renamed_file === true
              ? "renamed"
              : "modified",
      additions: added,
      deletions: removed,
      patch: c.diff.slice(0, 262_144) as string | null,
      truncated: c.diff.length > 262_144,
    },
    c.old_path !== c.new_path ? { previousPath: c.old_path } : null,
  );
}
