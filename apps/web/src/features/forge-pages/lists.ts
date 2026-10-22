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
import { useClient, useConnectionState } from "@ace/client-react";
import { keepPreviousData, useQueries, type QueryClient } from "@tanstack/react-query";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { readForge } from "@/lib/forge-read.ts";
import { repositoryParam } from "@/lib/pull-request-route.ts";

/** A list read again after half a minute; the last answer stays on screen while a new one reads. */
const listed = { staleTime: 30_000, gcTime: 10 * 60_000, retry: false } as const;

/** The pages of one search read so far, as one list. */
export interface ListPages<L extends ForgePrList | ForgeIssueList> {
  rows: L["items"][number][];
  /** The first page's answer: counts, viewer, repository. */
  first: L | undefined;
  /** A filter or search just changed and these rows are the previous answer's. */
  stale: boolean;
  loading: boolean;
  error: Error | undefined;
  /** Another page exists after the last one read. */
  more: boolean;
  retry(): void;
}

function useListPages<L extends ForgePrList | ForgeIssueList>(
  key: readonly unknown[],
  project: string | undefined,
  pages: number,
  read: (client: ClientApi, page: number, signal: AbortSignal) => Promise<L>,
): ListPages<L> {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const results = useQueries({
    queries: Array.from({ length: pages }, (_, index) => ({
      queryKey: ["forge", project, "browse", ...key, index + 1],
      queryFn: ({ signal }: { signal: AbortSignal }) => read(client, index + 1, signal),
      enabled: ready && !!project,
      ...listed,
      ...(index === 0 ? { placeholderData: keepPreviousData } : {}),
      meta: { daemonClient: client },
    })),
  });
  const first = results[0];
  const rows: L["items"][number][] = [];
  for (const result of results) if (result.data) rows.push(...result.data.items);
  const failed = results.find((result) => result.isError);
  return {
    rows,
    first: first?.data,
    stale: first?.isPlaceholderData ?? false,
    loading: !first?.data && !failed,
    error: failed?.error ?? undefined,
    more: results[results.length - 1]?.data?.nextPage !== undefined,
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

/** A project's pull requests matching `query`, `pages` pages of 25. */
export function usePrPages(project: string | undefined, query: ForgePrSearch, pages: number) {
  return useListPages<ForgePrList>(
    ["prList", withoutPage(query)],
    project,
    pages,
    (client, page, signal) => readPrPage(client, project ?? "", query, page, signal),
  );
}

/** A project's issues matching `query`, `pages` pages of 25. */
export function useIssuePages(project: string | undefined, query: ForgeIssueSearch, pages: number) {
  return useListPages<ForgeIssueList>(
    ["issueList", withoutPage(query)],
    project,
    pages,
    async (client, page, signal) => {
      const value = await readForge(
        client,
        { op: "forge.issue.list", workspaceId: project ?? "", query: { ...query, page } },
        signal,
      );
      if (value.resource !== "issueList") throw new Error("No issue list.");
      return value.value;
    },
  );
}

/**
 * Every group's total for the list on show, as GitHub counts it: one request per filter set,
 * kept as long as the list's pages are.
 */
export function useGroupCounts(project: string | undefined, grouping: ForgeGroupCounting) {
  return useDaemonQuery<Record<string, number>>({
    queryKey: ["forge", project, "browse", "groupCounts", grouping],
    enabled: !!project,
    ...listed,
    placeholderData: keepPreviousData,
    read: async (client, signal) => {
      const value = await readForge(
        client,
        { op: "forge.group-counts", workspaceId: project ?? "", grouping },
        signal,
      );
      if (value.resource !== "groupCounts") throw new Error("No group counts.");
      return value.counts;
    },
  });
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
  repository?: { owner: string; name: string },
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
            same(item.ref.repository.name, repository.name))),
    );
    if (row) return row;
  }
  return undefined;
}
