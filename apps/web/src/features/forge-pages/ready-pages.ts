import {
  prQuery,
  type PullsSearch,
  nextReadyRead,
  readinessQueries,
  type ReadyRead,
} from "@ace/ui-core";
import { useMemo, useState } from "react";
import type { ForgePrList, ForgePrRow } from "@ace/protocol";
import { useClient, useConnectionState } from "@ace/client-react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { prPageKey, readPrPage, usePrPages, type ListPages } from "./lists.ts";

/** Rows to show per screen: one page's worth, then another per "Show more". */
const screenful = 25;

const identity = (row: ForgePrRow) =>
  `${row.ref.repository.owner}/${row.ref.repository.name}#${row.ref.number}`;

/**
 * The pull requests the "Ready to merge" sort ranks. A repository whose open PRs fit in the
 * first page is ranked from that page alone. A larger one is read through `readinessQueries`
 * readiest first, a page at a time, until a screenful shows: each read waits for the one before
 * it, and every page is cached per filters like any list page, so typing or switching back
 * doesn't ask GitHub again within the half minute.
 */
export function useReadyPages(project: string | undefined, search: PullsSearch, active: boolean) {
  const client = useClient();
  const cache = useQueryClient();
  const ready = useConnectionState() === "ready";
  const fallbackKey = JSON.stringify([project, prQuery(search, 1)]);
  const [fallbackPaging, setFallbackPaging] = useState({ key: fallbackKey, pages: 1 });
  const fallbackPages = fallbackPaging.key === fallbackKey ? fallbackPaging.pages : 1;
  const head = usePrPages(project ? [project] : [], prQuery(search, 1), fallbackPages);
  const first = head.first;
  // Everything fits in the first page: the ranking is exact without another search.
  const exhaustive = first !== undefined && first.nextPage === undefined;
  const queries = useMemo(() => readinessQueries(search), [search]);
  const listKey = JSON.stringify([project, queries]);
  const [more, setMore] = useState({ key: listKey, screens: 1 });
  const target = screenful * (more.key === listKey ? more.screens : 1);
  const keyOf = (step: ReadyRead) => {
    const query = queries[step.query] ?? prQuery(search, 1);
    return { query, key: prPageKey(project, query, step.page) };
  };
  // The steps follow from what is already read: the chain stops at the first page still on its
  // way, or once a screenful of rows shows.
  const steps: ReadyRead[] = [];
  const answers: (ForgePrList | undefined)[] = [];
  const seen = new Set<string>();
  if (active && first && !exhaustive)
    for (;;) {
      const step = nextReadyRead(steps, answers, queries.length);
      if (!step || seen.size >= target) break;
      steps.push(step);
      const answer = cache.getQueryData<ForgePrList>(keyOf(step).key);
      answers.push(answer);
      for (const row of answer?.items ?? []) seen.add(identity(row));
      if (!answer) break;
    }
  const results = useQueries({
    queries: steps.map((step) => {
      const { query, key } = keyOf(step);
      return {
        queryKey: key,
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          readPrPage(client, project ?? "", query, step.page, signal),
        enabled: ready && !!project,
        staleTime: 30_000,
        gcTime: 10 * 60_000,
        retry: false,
        meta: { daemonClient: client },
      };
    }),
  });
  // Ranked through the searches, the newest-first page only supplies counts and the viewer.
  const rows: ForgePrRow[] = exhaustive
    ? head.rows
    : results.flatMap((result) => result.data?.items ?? []);
  const unique = rows.filter(
    (row, index) => rows.findIndex((r) => identity(r) === identity(row)) === index,
  );
  const settled = results.every((result) => result.data !== undefined || result.isError);
  const failed = results.find((result) => result.isError);
  const next =
    active && !exhaustive && first ? nextReadyRead(steps, answers, queries.length) : undefined;
  // Ranking is optional: when it has nothing to show because a search failed, or the
  // connection is down, the ordinary newest-first list stands in, with its own paging. Ranked
  // rows already read stay on show when a later page fails.
  const unranked = active && !exhaustive && unique.length === 0 && (failed !== undefined || !ready);
  if (!unranked && fallbackPaging.pages !== 1) setFallbackPaging({ key: fallbackKey, pages: 1 });
  const retry = () => {
    if (head.error || head.failed.length > 0) head.retry();
    void Promise.all(results.filter((result) => result.isError).map((result) => result.refetch()));
  };
  const pages: ListPages<ForgePrList> = {
    rows: unique,
    first,
    firsts: head.firsts,
    projectOf: () => project ?? "",
    failed: [],
    stale: head.stale,
    loading: head.loading || (!exhaustive && unique.length === 0 && !settled),
    error: head.error,
    errorProject: head.errorProject,
    more: next !== undefined && settled,
    retry,
  };
  return {
    ...(unranked ? { ...head, retry } : pages),
    /** A ranking search failed: the list is unranked, or ranked only as far as it got. */
    rankingError: failed?.error,
    unranked,
    loadMore: () => {
      if (unranked) {
        setFallbackPaging((current) => ({
          key: fallbackKey,
          pages: (current.key === fallbackKey ? current.pages : 1) + 1,
        }));
      } else {
        setMore((current) => ({
          key: listKey,
          screens: (current.key === listKey ? current.screens : 1) + 1,
        }));
      }
    },
  };
}
