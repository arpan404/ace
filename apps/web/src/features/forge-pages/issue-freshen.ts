import {
  ForgeIssueRow,
  ForgeIssueSearch,
  type ForgeIssueDetail,
  type ForgeIssueList,
  type ForgeRepository,
} from "@ace/protocol";
import type { QueryClient } from "@tanstack/react-query";

/**
 * GitHub's issue search trails a change by seconds or more, so a list read right after closing
 * or labelling an issue can still show it as it was. The issue's own read doesn't trail. These
 * put the newer of the two on every list row, and move a row out of (or into) a list whose
 * filters it no longer (or now) matches.
 */

const lower = (value: string) => value.toLowerCase();

/** Whether a row belongs in a list with these filters, as far as its own fields can tell. */
function matches(row: ForgeIssueRow, query: ForgeIssueSearch): boolean {
  if (row.state !== query.state) return false;
  const labels = new Set(row.labels.map(lower));
  if (!query.labels.every((label) => labels.has(lower(label)))) return false;
  if (query.milestone && lower(row.milestone ?? "") !== lower(query.milestone)) return false;
  if (query.assignee && query.assignee !== "@me")
    if (!row.assignees.map(lower).includes(lower(query.assignee))) return false;
  return true;
}

/** Filters a row's fields alone can't settle, so a row is never added to such a list. */
const opaque = (query: ForgeIssueSearch) =>
  query.search.trim() !== "" || query.author !== "" || query.assignee === "@me";

/** The row's fields of an issue read in full. */
const rowOf = (detail: ForgeIssueDetail): ForgeIssueRow => ForgeIssueRow.parse(detail);

/** One repository: same forge, host, owner and name. A fork or another host is another one. */
const sameRepository = (a: ForgeRepository, b: ForgeRepository) =>
  a.forge === b.forge &&
  lower(a.host) === lower(b.host) &&
  lower(a.owner) === lower(b.owner) &&
  lower(a.name) === lower(b.name);

/** What a row shows, so an equal-time read that says the same thing changes nothing. */
const shown = (row: ForgeIssueRow) =>
  JSON.stringify([
    row.title,
    row.state,
    row.labels,
    row.assignees,
    row.milestone,
    row.commentCount,
  ]);

/**
 * One page of a list with each issue read on its own since put in: newer rows replace older
 * ones, rows that left the list's filters go (and its counts follow), and on the first page of
 * a list by latest update, a row that now matches joins in its place.
 */
export function freshenIssueList(
  list: ForgeIssueList,
  query: ForgeIssueSearch,
  page: number,
  details: readonly ForgeIssueDetail[],
): ForgeIssueList {
  let items = list.items;
  const counts = { ...list.counts };
  let total = list.total;
  let changed = false;
  for (const detail of details) {
    // A project's cache can hold issues of other repositories it has read (a fork, an upstream).
    if (!sameRepository(detail.ref.repository, list.repository)) continue;
    const fresh = rowOf(detail);
    const index = items.findIndex((row) => row.ref.number === fresh.ref.number);
    const old = items[index];
    if (old) {
      // GitHub's update times are to the second, so two changes in one second share one. On a
      // tie the issue's own read wins: search trails it and never runs ahead of it.
      if (fresh.updatedAt < old.updatedAt) continue;
      if (fresh.updatedAt === old.updatedAt && shown(fresh) === shown(old)) continue;
      changed = true;
      if (matches(fresh, query)) {
        items = items.with(index, { ...old, ...fresh });
        continue;
      }
      items = items.toSpliced(index, 1);
      total = Math.max(0, total - 1);
      if (old.state !== fresh.state) {
        counts[old.state] = Math.max(0, counts[old.state] - 1);
        counts[fresh.state] += 1;
      }
      continue;
    }
    const byUpdate = query.sort === "updated" && query.order === "desc";
    if (page !== 1 || !byUpdate || opaque(query) || !matches(fresh, query)) continue;
    const oldest = items.at(-1);
    // A full page whose last row is newer than this one: it belongs on a later page.
    if (items.length >= 25 && oldest && oldest.updatedAt > fresh.updatedAt) continue;
    const at = items.findIndex((row) => row.updatedAt < fresh.updatedAt);
    items = (at < 0 ? [...items, fresh] : items.toSpliced(at, 0, fresh)).slice(0, 25);
    changed = true;
  }
  return changed ? { ...list, items, counts, total } : list;
}

/** Every issue of a project this device has read on its own, newest reads included. */
export function readIssues(cache: QueryClient, project: string): ForgeIssueDetail[] {
  return cache
    .getQueriesData<ForgeIssueDetail>({ queryKey: ["forge", project, "browse", "issueDetail"] })
    .flatMap(([, detail]) => (detail ? [detail] : []));
}

/** The list pages of a project read so far, each made to agree with the issues read since. */
export function freshenIssueLists(cache: QueryClient, project: string): void {
  const details = readIssues(cache, project);
  for (const [key, list] of cache.getQueriesData<ForgeIssueList>({
    queryKey: ["forge", project, "browse", "issueList"],
  })) {
    // The key holds the search without its page (`lists.ts`), then the page.
    const query = ForgeIssueSearch.safeParse({ ...Object(key[4]), page: 1 });
    const page = key[5];
    if (!list || !query.success || typeof page !== "number") continue;
    const next = freshenIssueList(list, query.data, page, details);
    if (next !== list) cache.setQueryData(key, next);
  }
}
