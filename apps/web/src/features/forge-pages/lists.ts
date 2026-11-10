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
import { reviewSourceId, workKey, type ReviewSource } from "@ace/ui-core";
import { useClient, useConnectionState } from "@ace/client-react";
import {
  keepPreviousData,
  useQueries,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { readForge } from "@/lib/forge-read.ts";
import { readFailureText } from "@/features/forge/index.ts";
import { useProjectRepositories } from "./inbox-projects.ts";
import { repositoryParam } from "@/lib/pull-request-route.ts";
import { freshenIssueList, readIssues } from "./issue-freshen.ts";

/** A list read again after half a minute; the last answer stays on screen while a new one reads. */
const listed = { staleTime: 30_000, gcTime: 10 * 60_000, retry: false } as const;

/** The pages of one search read so far across the chosen projects, as one list. */
export interface ListPages<L extends ForgePrList | ForgeIssueList> {
  rows: L["items"][number][];
  /** The first read's first page: viewer, repository. */
  first: L | undefined;
  /** Each read's first page, once read, by `reviewSourceId` (the project id for its primary). */
  firsts: ReadonlyMap<string, L>;
  /** The project a row came from. */
  projectOf(row: L["items"][number]): string;
  /** A filter or search just changed and these rows are the previous answer's. */
  stale: boolean;
  loading: boolean;
  /** Every read failed: the first failure. */
  error: Error | undefined;
  /** The project whose read is `error`. */
  errorProject: string | undefined;
  /** The read that is `error`. */
  errorSource?: ReviewSource | undefined;
  /** Reads that failed while others answered. */
  failed: readonly ReviewSource[];
  /** Another page exists after the last one read, in some read. */
  more: boolean;
  retry(): void;
}

const rowKey = (row: { ref: { repository: ForgeRepository; number: number } }) =>
  workKey(row.ref.repository, row.ref.number);

/** The projects' primaries alone: one read each, as lists read before ADR 0116. */
export const primarySources = (projects: readonly string[]): ReviewSource[] =>
  projects.map((project) => ({ project }));

/**
 * One cached read per source and page: page 2 of a source is asked for only once its page 1
 * says there is one, so "Show more" reads only the sources with more. Rows come in the
 * sources' order, each once (two projects on one repository show its rows once).
 */
function useListPages<L extends ForgePrList | ForgeIssueList>(
  key: readonly unknown[],
  sources: readonly ReviewSource[],
  pages: number,
  read: (client: ClientApi, source: ReviewSource, page: number, signal: AbortSignal) => Promise<L>,
): ListPages<L> {
  const client = useClient();
  const cache = useQueryClient();
  const ready = useConnectionState() === "ready";
  // A primary's pages keep the key they had before a project could list several repositories.
  const keyOf = (source: ReviewSource, page: number) => [
    "forge",
    source.project,
    "browse",
    ...key,
    page,
    ...(source.repository ? [repositoryParam(source.repository)] : []),
  ];
  const plan = sources.flatMap((source) =>
    Array.from({ length: pages }, (_, index) => ({ source, page: index + 1 })),
  );
  const results = useQueries({
    queries: plan.map(({ source, page }) => ({
      queryKey: keyOf(source, page),
      queryFn: ({ signal }: { signal: AbortSignal }) => read(client, source, page, signal),
      enabled:
        ready && (page === 1 || cache.getQueryData<L>(keyOf(source, page - 1))?.nextPage === page),
      ...listed,
      ...(page === 1 ? { placeholderData: keepPreviousData } : {}),
      meta: { daemonClient: client },
    })),
  });
  const rows: L["items"][number][] = [];
  const owner = new Map<string, string>();
  const firsts = new Map<string, L>();
  const failed = new Map<string, ReviewSource>();
  let stale = false;
  let more = false;
  let error: Error | undefined;
  let errorSource: ReviewSource | undefined;
  plan.forEach(({ source, page }, index) => {
    const result = results[index];
    if (!result) return;
    const id = reviewSourceId(source);
    if (result.isError) {
      failed.set(id, source);
      if (!error) {
        error = result.error;
        errorSource = source;
      }
    }
    const data = result.data;
    if (!data) return;
    if (page === 1) {
      firsts.set(id, data);
      stale ||= result.isPlaceholderData;
    }
    // The last page asked for of this source says whether it has more.
    if (page === pages && data.nextPage !== undefined) more = true;
    for (const row of data.items) {
      const key = rowKey(row);
      if (owner.has(key)) continue;
      owner.set(key, source.project);
      rows.push(row);
    }
  });
  const answered = firsts.size > 0;
  const first = sources.map((source) => firsts.get(reviewSourceId(source))).find(Boolean);
  return {
    rows,
    first,
    firsts,
    projectOf: (row) => owner.get(rowKey(row)) ?? sources[0]?.project ?? "",
    stale,
    loading: sources.length > 0 && !answered && failed.size < sources.length,
    error: answered ? undefined : error,
    errorProject: answered ? undefined : errorSource?.project,
    errorSource: answered ? undefined : errorSource,
    failed: answered ? [...failed.values()] : [],
    more,
    retry: () => void Promise.all(results.map((result) => result.refetch())),
  };
}

/**
 * Why every read failed, in the failing Git host's words (glab for GitLab, never gh). The
 * project's repository is asked for only once a read of its primary has failed.
 */
export function useListFailure(
  list: Pick<ListPages<ForgePrList | ForgeIssueList>, "error" | "errorProject" | "errorSource">,
): string | undefined {
  const named = list.errorSource?.repository?.forge;
  const failing = list.error && list.errorProject && !named ? [list.errorProject] : [];
  const repositories = useProjectRepositories(failing);
  if (!list.error) return undefined;
  const forge =
    named ?? (list.errorProject ? repositories.get(list.errorProject)?.forge : undefined);
  return readFailureText(list.error, forge);
}

const withoutPage = <T extends { page: number }>(query: T) => ({ ...query, page: 0 });

/** The cache key of one page of a PR search: every reader of that page shares it. */
export const prPageKey = (project: string | undefined, query: ForgePrSearch, page: number) =>
  ["forge", project, "browse", "prList", withoutPage(query), page] as const;

/** One page of 25 of a project's pull requests matching `query`. */
export async function readPrPage(
  client: ClientApi,
  source: string | ReviewSource,
  query: ForgePrSearch,
  page: number,
  signal: AbortSignal,
): Promise<ForgePrList> {
  const { project, repository } = typeof source === "string" ? { project: source } : source;
  const value = await readForge(
    client,
    {
      op: "forge.pr.list",
      workspaceId: project,
      ...(repository ? { repository } : {}),
      query: { ...query, page },
    },
    signal,
  );
  if (value.resource !== "prList") throw new Error("No pull request list.");
  return value.value;
}

/** Pull requests matching `query` from each source, up to `pages` pages of 25 each. */
export function usePrPages(sources: readonly ReviewSource[], query: ForgePrSearch, pages: number) {
  return useListPages<ForgePrList>(
    ["prList", withoutPage(query)],
    sources,
    pages,
    (client, source, page, signal) => readPrPage(client, source, query, page, signal),
  );
}

/** The projects' issues matching `query`, up to `pages` pages of 25 each. */
export function useIssuePages(projects: readonly string[], query: ForgeIssueSearch, pages: number) {
  const cache = useQueryClient();
  return useListPages<ForgeIssueList>(
    ["issueList", withoutPage(query)],
    primarySources(projects),
    pages,
    async (client, { project }, page, signal) => {
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
 * Every group's total for the list on show, as the host counts it, summed over the sources: one
 * request per source and filter set, kept as long as the list's pages are. Undefined until
 * every source has answered, so a total never undercounts.
 */
export function useGroupCounts(
  sources: readonly ReviewSource[],
  grouping: ForgeGroupCounting,
): {
  total: Record<string, number> | undefined;
  /** By `reviewSourceId`. */
  bySource: ReadonlyMap<string, Record<string, number>>;
} {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const results = useQueries({
    queries: sources.map((source) => ({
      queryKey: [
        "forge",
        source.project,
        "browse",
        "groupCounts",
        grouping,
        ...(source.repository ? [repositoryParam(source.repository)] : []),
      ],
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        const value = await readForge(
          client,
          {
            op: "forge.group-counts",
            workspaceId: source.project,
            ...(source.repository ? { repository: source.repository } : {}),
            grouping,
          },
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
  const bySource = new Map<string, Record<string, number>>();
  results.forEach((result, index) => {
    const source = sources[index];
    if (source && result.data) bySource.set(reviewSourceId(source), result.data);
  });
  if (!sources.length || bySource.size < sources.length) return { total: undefined, bySource };
  const total: Record<string, number> = {};
  for (const counts of bySource.values())
    for (const [id, count] of Object.entries(counts)) total[id] = (total[id] ?? 0) + count;
  return { total, bySource };
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
 * says (title, state, author) at once while the rest loads. Rows match by their whole identity
 * (provider, host, owner, name, number); with no repository named, only the list's own
 * repository counts, so a same-numbered review on another host never stands in for this one.
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
  for (const [, data] of cache.getQueriesData<{ items: Row[]; repository?: ForgeRepository }>({
    queryKey: ["forge", project, "browse", kind],
  })) {
    const target = repository ?? data?.repository;
    if (!target) continue;
    const row = data?.items.find(
      (item) =>
        item.ref.number === number &&
        same(item.ref.repository.owner, target.owner) &&
        same(item.ref.repository.name, target.name) &&
        (target.forge === undefined || same(item.ref.repository.forge, target.forge)) &&
        (target.host === undefined || same(item.ref.repository.host, target.host)),
    );
    if (row) return row;
  }
  return undefined;
}
