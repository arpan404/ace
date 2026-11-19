import type {
  ForgeInboxList,
  ForgeInboxQuery,
  ForgeInboxRow,
  ForgeRepository,
  ProjectRepositories,
} from "@ace/protocol";
import { reviewRepositories, sameRepository } from "@ace/ui-core";
import { repositoryFromParam, repositoryParam } from "@/lib/pull-request-route.ts";

/** `/inbox?view=all&reason=mention&repo=github.com/acme/ace`: the inbox's filters, in the address. */
export interface InboxSearch {
  /** The projects picked; none is every project. */
  projects?: string[] | undefined;
  project?: string | undefined;
  /** Read notifications too; unread only when absent. */
  view?: "all" | undefined;
  /** Only threads the person takes part in. */
  only?: "participating" | undefined;
  reason?: string | undefined;
  /** One repository (`github.com/acme/ace`). */
  repo?: string | undefined;
  /** Group by repository; by date when absent. */
  group?: "repo" | undefined;
}

/** What GitHub is asked for: unread or all, participating, one repository. Reason is filtered here. */
export function inboxQuery(search: InboxSearch, page: number): ForgeInboxQuery {
  const repository = repositoryFromParam(search.repo);
  return {
    all: search.view === "all",
    participating: search.only === "participating",
    ...(repository ? { repository } : {}),
    page,
  };
}

/** The rows to show: one per thread across pages, of the chosen reason. */
export function visibleRows(
  pages: readonly (ForgeInboxList | undefined)[],
  search: InboxSearch,
): ForgeInboxRow[] {
  const seen = new Set<string>();
  const rows: ForgeInboxRow[] = [];
  for (const page of pages)
    for (const row of page?.items ?? []) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      if (!search.reason || row.reason === search.reason) rows.push(row);
    }
  return rows;
}

/**
 * The repositories for the filter column: every one the rows come from (and the one picked),
 * by name, each with its unread count.
 */
export function repositoryCounts(
  rows: readonly ForgeInboxRow[],
  selected: string | undefined,
): { id: string; count: number }[] {
  const counts = new Map<string, Set<string>>();
  if (selected) counts.set(selected, new Set());
  for (const row of rows) {
    const id = repositoryParam(row.repository);
    const unread = counts.get(id) ?? new Set<string>();
    if (row.unread) unread.add(row.id);
    counts.set(id, unread);
  }
  return [...counts]
    .map(([id, unread]) => ({ id, count: unread.size }))
    .toSorted((a, b) => a.id.localeCompare(b.id));
}

/**
 * Refusals asking again won't change by themselves: the person fixes them (signs in, adds a
 * remote) and tries again. Asked again only rarely, so a fix also shows up on its own.
 */
const settled = new Set([
  "forge_notifications_unavailable",
  "forge_unsupported",
  "forge_forbidden",
  "forge_no_remote",
  "git_not_a_repo",
  "workspace_not_found",
]);
/** Refusals that pass: a rate limit or a lost connection, asked again after a longer wait. */
const passing = new Set(["forge_rate_limit", "forge_offline"]);
export const inboxBackoffMs = 5 * 60_000;
export const inboxSettledMs = 15 * 60_000;

/**
 * How long until the inbox asks again: GitHub's poll interval; a few minutes after a rate limit
 * or a lost connection; a quarter of an hour after a refusal that won't pass by itself.
 */
export function inboxPollMs(data: ForgeInboxList | undefined, failure: string | undefined): number {
  if (failure && settled.has(failure)) return inboxSettledMs;
  if (failure && passing.has(failure)) return inboxBackoffMs;
  return (data?.pollSeconds ?? 60) * 1_000;
}

export interface InboxGroup {
  id: string;
  label: string;
  rows: ForgeInboxRow[];
}

const dayMs = 24 * 60 * 60_000;
const dates = [
  { id: "today", label: "Today", days: 0 },
  { id: "yesterday", label: "Yesterday", days: 1 },
  { id: "week", label: "This week", days: 6 },
  { id: "month", label: "This month", days: 29 },
] as const;

/**
 * The rows under GitHub's group bands, each band keeping GitHub's newest-first order. By date:
 * Today, Yesterday, This week, This month, Older, by the local day `now` falls on. By
 * repository: one band per repository, in the order they first appear. Empty bands are left out.
 */
export function inboxGroups(
  rows: readonly ForgeInboxRow[],
  by: "date" | "repo",
  now: number,
): InboxGroup[] {
  if (by === "repo") {
    const groups = new Map<string, InboxGroup>();
    for (const row of rows) {
      const id = repoKey(row.repository);
      let group = groups.get(id);
      if (!group) {
        group = { id, label: `${row.repository.owner}/${row.repository.name}`, rows: [] };
        groups.set(id, group);
      }
      group.rows.push(row);
    }
    return [...groups.values()];
  }
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const start = midnight.getTime();
  const groups: InboxGroup[] = [
    ...dates.map((date) => ({ id: date.id, label: date.label, rows: [] as ForgeInboxRow[] })),
    { id: "older", label: "Older", rows: [] },
  ];
  for (const row of rows) {
    const at = Date.parse(row.updatedAt);
    const index = dates.findIndex((date) => at >= start - date.days * dayMs);
    groups[index === -1 || Number.isNaN(at) ? dates.length : index]?.rows.push(row);
  }
  return groups.filter((group) => group.rows.length > 0);
}

const repoKey = (repository: { host: string; owner: string; name: string }) =>
  `${repository.host}/${repository.owner}/${repository.name}`.toLowerCase();

type InboxRepository = { host: string; owner: string; name: string };

/** A project's repositories as the inbox tags rows with them (ADR 0120). */
export interface InboxProjectRepositories<R extends InboxRepository = InboxRepository> {
  primary?: R | undefined;
  /** Its other visible, available repositories; only a project with saved choices has any. */
  others: readonly R[];
}

/**
 * A project's repositories for the inbox: its primary (from `forge.repositories`, else
 * `fallback`, the primary an older daemon or a failed list read still names) and, only when the
 * project has saved choices, its other visible, available ones. With no saved choices a project
 * tags rows with its primary alone, as before.
 */
export function inboxRepositoriesOf(
  value: ProjectRepositories | undefined,
  fallback: ForgeRepository | undefined,
): InboxProjectRepositories<ForgeRepository> {
  const primary = value ? (value.primary ?? undefined) : fallback;
  const others = value?.config
    ? reviewRepositories(value).filter(
        (repository) => !primary || !sameRepository(repository, primary),
      )
    : [];
  return { primary, others };
}

/**
 * Each row's project, by its repository; `repositories` maps each project to its primary, or to
 * its primary and its other repositories. Every project's primary is matched first, so a row of
 * one project's primary never moves to another project that also uses that repository; among
 * primaries, and then among the others, a repository two projects share belongs to the first.
 * Rows of repositories no project uses stay without one.
 */
export function inboxProjects(
  repositories: ReadonlyMap<string, InboxRepository | InboxProjectRepositories>,
): (row: Pick<ForgeInboxRow, "repository">) => string | undefined {
  const byRepo = new Map<string, string>();
  const claim = (project: string, repository: InboxRepository | undefined) => {
    if (repository && !byRepo.has(repoKey(repository))) byRepo.set(repoKey(repository), project);
  };
  const split = (value: InboxRepository | InboxProjectRepositories) =>
    "others" in value ? value : { primary: value, others: [] };
  for (const [project, value] of repositories) claim(project, split(value).primary);
  for (const [project, value] of repositories)
    for (const repository of split(value).others) claim(project, repository);
  return (row) => byRepo.get(repoKey(row.repository));
}

/** Whether a row's repository is this one: a row of a project's primary opens without naming it. */
export const sameInboxRepository = (
  a: { host: string; owner: string; name: string },
  b: { host: string; owner: string; name: string } | undefined,
) => b !== undefined && repoKey(a) === repoKey(b);

/**
 * The rows the project choice keeps: every row when every project shows (notifications are the
 * account's, so repositories outside ace's projects too); else only the picked projects' rows.
 */
export function rowsForProjects(
  rows: readonly ForgeInboxRow[],
  picked: readonly string[],
  projectOf: (row: ForgeInboxRow) => string | undefined,
): ForgeInboxRow[] {
  if (!picked.length) return [...rows];
  const wanted = new Set(picked);
  return rows.filter((row) => {
    const project = projectOf(row);
    return project !== undefined && wanted.has(project);
  });
}
