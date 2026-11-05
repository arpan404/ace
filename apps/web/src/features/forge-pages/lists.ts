import type { ClientApi } from "@ace/client";
import type {
  ForgeGroupCounting,
  ForgeIssueDetail,
  ForgeIssueList,
  ForgeIssueSearch,
  ForgePrList,
  ForgePrRow,
  ForgePrSearch,
  ForgeIssueRow,
  ForgeRepository,
} from "@ace/protocol";
import { workKey } from "@ace/ui-core";
import { useClient, useConnectionState } from "@ace/client-react";
import {
  keepPreviousData,
  useQueries,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { readForge } from "@/lib/forge-read.ts";
import { repositoryParam } from "@/lib/pull-request-route.ts";
import { freshenIssueList, readIssues } from "./issue-freshen.ts";

/** A list read again after half a minute; the last answer stays on screen while a new one reads. */
const listed = { staleTime: 30_000, gcTime: 10 * 60_000, retry: false } as const;

/** The pages of one search read so far across the chosen projects, as one list. */
export interface ListPages<L extends ForgePrList | ForgeIssueList> {
  rows: L["items"][number][];
  /** The first project's first page: viewer, repository. */
  first: L | undefined;
  /** Each project's first page, once read. */
  firsts: ReadonlyMap<string, L>;
  /** The project a row came from. */
  projectOf(row: L["items"][number]): string;
  /** A filter or search just changed and these rows are the previous answer's. */
  stale: boolean;
  loading: boolean;
  /** Every project's read failed: the first failure. */
  error: Error | undefined;
  /** Projects whose read failed while others answered. */
  failed: readonly string[];
  /** Another page exists after the last one read, in some project. */
  more: boolean;
  retry(): void;
}

const rowKey = (row: { ref: { repository: ForgeRepository; number: number } }) =>
  workKey(row.ref.repository, row.ref.number);

/**
 * One cached read per project and page: page 2 of a project is asked for only once its page 1
 * says there is one, so "Show more" reads only the projects with more. Rows come in the
 * projects' order, each once (two projects on one repository show its rows once).
 */
function useListPages<L extends ForgePrList | ForgeIssueList>(
  key: readonly unknown[],
  projects: readonly string[],
  pages: number,
  read: (client: ClientApi, project: string, page: number, signal: AbortSignal) => Promise<L>,
): ListPages<L> {
  const client = useClient();
  const cache = useQueryClient();
  const ready = useConnectionState() === "ready";
  const keyOf = (project: string, page: number) => ["forge", project, "browse", ...key, page];
  const plan = projects.flatMap((project) =>
    Array.from({ length: pages }, (_, index) => ({ project, page: index + 1 })),
  );
  const results = useQueries({
    queries: plan.map(({ project, page }) => ({
      queryKey: keyOf(project, page),
      queryFn: ({ signal }: { signal: AbortSignal }) => read(client, project, page, signal),
      enabled:
        ready && (page === 1 || cache.getQueryData<L>(keyOf(project, page - 1))?.nextPage === page),
      ...listed,
      ...(page === 1 ? { placeholderData: keepPreviousData } : {}),
      meta: { daemonClient: client },
    })),
  });
  const rows: L["items"][number][] = [];
  const owner = new Map<string, string>();
  const firsts = new Map<string, L>();
  const failed = new Set<string>();
  let stale = false;
  let more = false;
  let error: Error | undefined;
  plan.forEach(({ project, page }, index) => {
    const result = results[index];
    if (!result) return;
    if (result.isError) {
      failed.add(project);
      error ??= result.error;
    }
    const data = result.data;
    if (!data) return;
    if (page === 1) {
      firsts.set(project, data);
      stale ||= result.isPlaceholderData;
    }
    // The last page asked for of this project says whether it has more.
    if (page === pages && data.nextPage !== undefined) more = true;
    for (const row of data.items) {
      const id = rowKey(row);
      if (owner.has(id)) continue;
      owner.set(id, project);
      rows.push(row);
    }
  });
  const answered = firsts.size > 0;
  const first = projects.map((project) => firsts.get(project)).find(Boolean);
  return {
    rows,
    first,
    firsts,
    projectOf: (row) => owner.get(rowKey(row)) ?? projects[0] ?? "",
    stale,
    loading: projects.length > 0 && !answered && failed.size < projects.length,
    error: answered ? undefined : error,
    failed: answered ? [...failed] : [],
    more,
    retry: () => void Promise.all(results.map((result) => result.refetch())),
  };
}

const withoutPage = <T extends { page: number }>(query: T) => ({ ...query, page: 0 });

/** The cache key of one page of a PR search: every reader of that page shares it. */
export const prPageKey = (project: string | undefined, query: ForgePrSearch, page: number) =>
  ["forge", project, "browse", "prList", withoutPage(query), page] as const;

/** One page of 25 of a project's pull requests matching `query`. */
export async function readPrPage(
  client: ClientApi,
  project: string,
  query: ForgePrSearch,
  page: number,
  signal: AbortSignal,
): Promise<ForgePrList> {
  const value = await readForge(
    client,
    { op: "forge.pr.list", workspaceId: project, query: { ...query, page } },
    signal,
  );
  if (value.resource !== "prList") throw new Error("No pull request list.");
  return value.value;
}

/** The projects' pull requests matching `query`, up to `pages` pages of 25 each. */
export function usePrPages(projects: readonly string[], query: ForgePrSearch, pages: number) {
  return useListPages<ForgePrList>(
    ["prList", withoutPage(query)],
    projects,
    pages,
    (client, project, page, signal) => readPrPage(client, project, query, page, signal),
  );
}

/** The projects' issues matching `query`, up to `pages` pages of 25 each. */
export function useIssuePages(projects: readonly string[], query: ForgeIssueSearch, pages: number) {
  const cache = useQueryClient();
  return useListPages<ForgeIssueList>(
    ["issueList", withoutPage(query)],
    projects,
    pages,
    async (client, project, page, signal) => {
      const value = await readForge(
        client,
        { op: "forge.issue.list", workspaceId: project, query: { ...query, page } },
        signal,
      );
      if (value.resource !== "issueList") throw new Error("No issue list.");
      // Search trails a write; an issue read since says how it is now.
      return freshenIssueList(value.value, query, page, readIssues(cache, project));
    },
  );
}

/**
 * Every group's total for the list on show, as GitHub counts it, summed over the projects: one
 * request per project and filter set, kept as long as the list's pages are. Undefined until
 * every project has answered, so a total never undercounts.
 */
export function useGroupCounts(
  projects: readonly string[],
  grouping: ForgeGroupCounting,
): {
  total: Record<string, number> | undefined;
  byProject: ReadonlyMap<string, Record<string, number>>;
} {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const results = useQueries({
    queries: projects.map((project) => ({
      queryKey: ["forge", project, "browse", "groupCounts", grouping],
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        const value = await readForge(
          client,
          { op: "forge.group-counts", workspaceId: project, grouping },
          signal,
        );
        if (value.resource !== "groupCounts") throw new Error("No group counts.");
        return value.counts;
      },
      enabled: ready,
      ...listed,
      placeholderData: keepPreviousData,
      meta: { daemonClient: client },
    })),
  });
  const byProject = new Map<string, Record<string, number>>();
  results.forEach((result, index) => {
    const project = projects[index];
    if (project && result.data) byProject.set(project, result.data);
  });
  if (!projects.length || byProject.size < projects.length) return { total: undefined, byProject };
  const total: Record<string, number> = {};
  for (const counts of byProject.values())
    for (const [id, count] of Object.entries(counts)) total[id] = (total[id] ?? 0) + count;
  return { total, byProject };
}

export const issueDetailKey = (project: string, number: number, repo = "") =>
  ["forge", project, "browse", "issueDetail", number, repo] as const;

/**
 * One issue: its body, labels, people, permissions and the threads linked to it. `repository`
 * names a repository other than the project's own.
 */
export function useIssueDetail(project: string, number: number, repository?: ForgeRepository) {
  return useDaemonQuery<ForgeIssueDetail>({
    queryKey: issueDetailKey(project, number, repository ? repositoryParam(repository) : ""),
    staleTime: 15_000,
    gcTime: 10 * 60_000,
    retry: false,
    read: async (client, signal) => {
      const value = await readForge(
        client,
        {
          op: "forge.issue.detail",
          workspaceId: project,
          number,
          ...(repository ? { repository } : {}),
        },
        signal,
      );
      if (value.resource !== "issueDetail") throw new Error("No issue.");
      return value.value;
    },
  });
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * A row a list already read for this pull request or issue, if any: its page shows what the row
 * says (title, state, author) at once while the rest loads.
 */
export function cachedRow<K extends "prList" | "issueList">(
  cache: QueryClient,
  project: string,
  kind: K,
  number: number,
  repository?: Pick<ForgeRepository, "owner" | "name"> &
    Partial<Pick<ForgeRepository, "forge" | "host">>,
): (K extends "prList" ? ForgePrRow : ForgeIssueRow) | undefined {
  type Row = K extends "prList" ? ForgePrRow : ForgeIssueRow;
  for (const [, data] of cache.getQueriesData<{ items: Row[] }>({
    queryKey: ["forge", project, "browse", kind],
  })) {
    const row = data?.items.find(
      (item) =>
        item.ref.number === number &&
        (!repository ||
          (same(item.ref.repository.owner, repository.owner) &&
            same(item.ref.repository.name, repository.name) &&
            (repository.forge === undefined || same(item.ref.repository.forge, repository.forge)) &&
            (repository.host === undefined || same(item.ref.repository.host, repository.host)))),
    );
    if (row) return row;
  }
  return undefined;
}
