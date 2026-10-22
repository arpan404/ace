import type { ForgeCompare, ForgeNewPrContext } from "@ace/protocol";

/** "feature/release-notes" as a title: "Feature/release notes". */
export function branchTitle(branch: string): string {
  const words = branch.replaceAll(/[-_]+/g, " ").trim();
  return words ? `${words[0]?.toUpperCase() ?? ""}${words.slice(1)}` : branch;
}

/**
 * The title and description a new pull request starts with, as GitHub fills them: one commit
 * gives its subject (and its body, without a template); several give the branch's name. The
 * repository's template, when it has one, is the description.
 */
export function prefill(
  head: string,
  compare: ForgeCompare | undefined,
  template: string | null | undefined,
): { title: string; body: string } {
  const only = compare?.commits.length === 1 ? compare.commits[0] : undefined;
  const [subject = "", ...rest] = (only?.message ?? "").split("\n");
  const commitBody = rest.join("\n").trim();
  return {
    title: only && subject.trim() ? subject.trim() : branchTitle(head),
    body: template ?? commitBody,
  };
}

/** The base the page starts on: the one asked for when it exists, else the default branch. */
export function startingBase(context: ForgeNewPrContext, asked: string | undefined): string {
  return asked && context.base.branches.some((branch) => branch.name === asked)
    ? asked
    : context.base.defaultBranch;
}

/** What stands between the two branches and a pull request, or undefined when nothing does. */
export function compareBlocker(
  base: string,
  head: string | undefined,
  compare: ForgeCompare | undefined,
): string | undefined {
  if (!head) return "Pick the branch with your changes.";
  if (head === base) return "Pick two different branches.";
  if (!compare) return undefined;
  if (compare.status === "identical") return `${head} and ${base} are the same.`;
  if (compare.aheadBy === 0) return `${head} has no commits that ${base} doesn't.`;
  return undefined;
}

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

/** "3 commits · 4 files · +202 −1" for an open comparison. */
export function compareSummary(compare: ForgeCompare): string {
  const added = compare.files.reduce((sum, file) => sum + file.additions, 0);
  const removed = compare.files.reduce((sum, file) => sum + file.deletions, 0);
  const lines = compare.nextPage ? "" : ` · +${added} −${removed}`;
  return `${plural(compare.totalCommits, "commit")} · ${plural(compare.totalFiles, "file")}${lines}`;
}
