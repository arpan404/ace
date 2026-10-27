import { ForgeRepository, type ForgeCommit } from "@ace/protocol";
import { readCommitHistory, sinceLastReview, type SinceLastReview } from "@ace/ui-core";
import { z } from "zod";
import type { Preview } from "./agents.ts";
import { prDetail, scopeOf, type PrTarget } from "./forge-pr-reads.ts";
import { ForgeRefusal, type ForgeReads } from "./forge-reads.ts";

/*
 * A pull request's commits for the phone's Commits list, read as the web reads them (newest
 * page first, a long history a few pages at once), shown oldest first as GitHub lists them.
 * Each opens its own files; two of them name a span to compare.
 */

const sha = z.string().regex(/^[a-fA-F0-9]{40,64}$/);

export const ForgeCommitsRequest = z.object({
  type: z.literal("forge.pull.commits"),
  project: z.string().min(1).max(512),
  number: z.number().int().positive(),
  repository: ForgeRepository.optional(),
});
export type ForgeCommitsRequest = z.infer<typeof ForgeCommitsRequest>;

/** What a pull request's Files changed shows: one commit, or what changed after `since`. */
export const ForgeRange = z.object({ commit: sha, since: sha.optional() });
export type ForgeRange = z.infer<typeof ForgeRange>;

export interface CommitRow {
  sha: string;
  short: string;
  title: string;
  author: string;
  /** Milliseconds since 1970; null where GitHub gave no date. */
  at: number | null;
  additions: number | null;
  deletions: number | null;
}

export interface CommitsReply {
  type: "forge.pull.commits";
  headSha: string;
  /** The commits after the signed-in reviewer's latest review, when there are any. */
  sinceReview: SinceLastReview | null;
  /** Oldest first. */
  commits: CommitRow[];
  /** GitHub listed only the newest of a very long history. */
  truncated: boolean;
}

export const shortSha = (value: string) => value.slice(0, 7);

/** A commit's first line, as GitHub titles it. */
export const commitTitle = (commit: ForgeCommit) => commit.message.split("\n")[0] ?? "";

export async function prCommitHistory(
  reads: ForgeReads,
  target: PrTarget,
  headSha: string,
): Promise<{ commits: ForgeCommit[]; truncated: boolean }> {
  return readCommitHistory(
    async (before) => {
      const value = await reads.read(
        {
          op: "forge.pr.commits",
          ...scopeOf(target),
          headSha,
          ...(before === undefined ? {} : { before }),
        },
        true,
      );
      if (value.resource !== "prCommits") throw new ForgeRefusal("forge_invalid_data");
      return value;
    },
    () => {},
  );
}

export async function readCommits(
  reads: ForgeReads,
  request: ForgeCommitsRequest,
  preview: Preview,
): Promise<CommitsReply> {
  const detail = await prDetail(reads, request);
  const headSha = detail.status.headSha;
  const history = await prCommitHistory(reads, request, headSha);
  // Who reviewed at which head is a nicety: the list still shows without it.
  const reviewers = await reads
    .read({ op: "forge.pr.reviewers", ...scopeOf(request) }, false)
    .then((value) => (value.resource === "prReviewers" ? value.value : undefined))
    .catch(() => undefined);
  return {
    type: "forge.pull.commits",
    headSha,
    sinceReview: (reviewers && sinceLastReview(reviewers, history.commits, headSha)) ?? null,
    commits: history.commits.map((commit) => {
      const at = commit.date ? Date.parse(commit.date) : Number.NaN;
      return {
        sha: commit.sha,
        short: shortSha(commit.sha),
        title: preview(commitTitle(commit), 512),
        author: preview(commit.author, 200),
        at: Number.isFinite(at) ? at : null,
        additions: commit.additions ?? null,
        deletions: commit.deletions ?? null,
      };
    }),
    truncated: history.truncated,
  };
}

/** The words for a range, by the commits it names. */
export function rangeLabel(range: ForgeRange | undefined, commits: readonly ForgeCommit[]): string {
  if (!range) return "All commits";
  const title = (value: string) => {
    const commit = commits.find((each) => each.sha === value);
    return commit ? commitTitle(commit) : shortSha(value);
  };
  if (!range.since) return title(range.commit);
  const from = commits.findIndex((each) => each.sha === range.since);
  const to = commits.findIndex((each) => each.sha === range.commit);
  const count = from >= 0 && to > from ? to - from : undefined;
  return count === undefined
    ? `Changes after ${shortSha(range.since)}`
    : `${count} ${count === 1 ? "commit" : "commits"} after ${shortSha(range.since)}`;
}
