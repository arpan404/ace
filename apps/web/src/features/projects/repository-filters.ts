import type { RepositoryListInput } from "@ace/protocol";

/** The GitHub list's filters behind ⋯, other than the host and account. */
export interface RepositoryFilters {
  owner: string;
  visibility: RepositoryListInput["visibility"];
  archived: RepositoryListInput["archived"];
  fork: RepositoryListInput["fork"];
}

/** What the list shows before anything is changed: every owner and visibility, no archives. */
export const defaultFilters: RepositoryFilters = {
  owner: "",
  visibility: "all",
  archived: "no",
  fork: "all",
};

/**
 * The filters that narrow the list from its defaults, in words for a status line ("owner ada",
 * "private only"). `account` is an account picked over the CLI's own, if any.
 */
export function activeFilters(filters: RepositoryFilters, account?: string): string[] {
  const words: string[] = [];
  if (account) words.push(`account ${account}`);
  if (filters.owner) words.push(`owner ${filters.owner}`);
  if (filters.visibility !== "all") words.push(`${filters.visibility} only`);
  if (filters.archived === "yes") words.push("archived only");
  else if (filters.archived === "all") words.push("archived included");
  if (filters.fork === "yes") words.push("forks only");
  else if (filters.fork === "no") words.push("no forks");
  return words;
}

/**
 * Whether two list reads differ only in their search text (at `textAt` in the key): then the
 * last answer may show, dimmed, while the new one comes. Any other change (account, owner, a
 * filter) is a different list.
 */
export function onlyTextChanged(
  before: readonly unknown[],
  after: readonly unknown[],
  textAt: number,
): boolean {
  return (
    before.length === after.length &&
    before.every((part, at) => at === textAt || Object.is(part, after[at]))
  );
}
