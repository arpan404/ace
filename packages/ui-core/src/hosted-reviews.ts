import { prUrl } from "@ace/forge/pr-reference";
import type { ForgeKind, ForgePrDetail, ForgeRepository } from "@ace/protocol";
import { can } from "./forge-capability.ts";
import { forgeDisplayName } from "./forge-hosts.ts";

/*
 * Reviews on hosts ace only reads (GitLab, Cursor Origin): when a review is read-only, what its
 * page says, which counts it may show, and where references in its text open. Web and the
 * iPhone read these; nothing here offers a write, which the daemon refuses for these hosts. Pure.
 */

/** Whether ace cannot comment on this review. Prefer individual capability checks for sections. */
export function isHostedReview(detail: Pick<ForgePrDetail, "status" | "capabilities">): boolean {
  return !can(detail, "reviews.comments.write");
}

/** What the provider calls a review: GitLab's merge requests, everyone else's pull requests. */
export function reviewNoun(forge: ForgeKind | undefined): string {
  return forge === "gitlab" ? "merge request" : "pull request";
}

/** The one sentence under a read-only review's header. */
export function hostedReviewLine(forge: ForgeKind): string {
  return `Some review actions are available only on ${forgeDisplayName(forge)}.`;
}

/** Said in place of the changed files when the host doesn't share them. */
export function hostedFilesUnavailableText(forge: ForgeKind): string {
  const provider = forgeDisplayName(forge);
  return `${provider} doesn't share this ${reviewNoun(forge)}'s changed files with ace. Open it on ${provider} to see them.`;
}

/** How many files changed, or null when the host didn't say (never a placeholder 0). */
export function knownFileCount(
  detail: Pick<ForgePrDetail, "changedFiles" | "unavailableResources">,
): number | null {
  const missing = detail.unavailableResources ?? [];
  return missing.includes("files") || missing.includes("fileCount") ? null : detail.changedFiles;
}

/** How many commits, or null when the host can't list them. */
export function knownCommitCount(
  detail: Pick<ForgePrDetail, "commits" | "unavailableResources">,
): number | null {
  return detail.unavailableResources?.includes("commits") ? null : detail.commits;
}

/**
 * Where each kind of reference in review text opens, as address templates (`{number}`, `{sha}`,
 * `{login}`); null leaves that kind inert. On GitLab `#12` is an issue (merge requests are
 * `!12`), so it opens on GitLab. On Cursor Origin `#12` is review 12 of the same repository,
 * which `review` says ace opens as its own page.
 */
export interface HostedLinks {
  issue: string | null;
  review: boolean;
  commit: string | null;
  mention: string | null;
}

export function hostedLinks(repository: ForgeRepository): HostedLinks {
  const base = `https://${repository.host}/${repository.owner}/${repository.name}`;
  if (repository.forge === "gitlab")
    return {
      issue: `${base}/-/issues/{number}`,
      review: false,
      commit: `${base}/-/commit/{sha}`,
      mention: `https://${repository.host}/{login}`,
    };
  if (repository.forge === "origin")
    return { issue: null, review: true, commit: null, mention: null };
  return { issue: null, review: false, commit: null, mention: null };
}

const segment = /^(?!\.{1,2}$)[\w.-]+$/;
const sameRepository = (repository: ForgeRepository, owner: string, name: string) =>
  repository.owner.toLowerCase() === owner.toLowerCase() &&
  repository.name.toLowerCase() === name.toLowerCase();

/**
 * The address a reference in a read-only review's text opens, from `hostedLinks`. Undefined when
 * it names another repository, isn't a reference these hosts link, or isn't well formed.
 */
export function hostedReferenceAddress(
  reference: { kind: string; target: string },
  repository: ForgeRepository,
): string | undefined {
  const links = hostedLinks(repository);
  const { kind, target } = reference;
  if (kind === "issue") {
    const match = /^(?:([\w./-]+)\/([\w.-]+))?#([1-9]\d*)$/.exec(target);
    if (!match) return undefined;
    const [, owner, name, number] = match;
    if (owner && name && !sameRepository(repository, owner, name)) return undefined;
    if (links.issue) return links.issue.replace("{number}", number ?? "");
    if (!links.review) return undefined;
    try {
      return prUrl({ repository, number: Number(number) });
    } catch {
      return undefined;
    }
  }
  if (kind === "commit")
    return links.commit && /^[0-9a-f]{7,40}$/i.test(target)
      ? links.commit.replace("{sha}", target)
      : undefined;
  if (kind === "mention")
    return links.mention && segment.test(target)
      ? links.mention.replace("{login}", target)
      : undefined;
  return undefined;
}
