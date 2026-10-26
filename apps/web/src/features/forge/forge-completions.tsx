import { useMemo, type ReactNode } from "react";
import { useClient } from "@ace/client-react";
import { useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import type { ForgeRepository } from "@ace/protocol";
import {
  MarkdownCompletionsProvider,
  type CompletionPerson,
  type MarkdownCompletions,
} from "@/components/markdown-editor/completion-source.ts";
import { rankPeople, referenceMatches, referenceSearch, searchable } from "@ace/ui-core";
import { readForge } from "@/lib/forge-read.ts";

/** How long a search's answer is reused: who can be mentioned rarely changes. */
const peopleFreshMs = 5 * 60_000;
const referencesFreshMs = 60_000;

/**
 * A cached read that stops when `signal` does: a search the editor has moved past is cancelled
 * in the daemon too, not left to finish unread. Searches of the same text share one read
 * (`waiting` counts them), which is cancelled only once every one of them has moved on.
 */
async function fetchUntil<T>(
  cache: QueryClient,
  waiting: Map<string, number>,
  signal: AbortSignal,
  options: {
    queryKey: QueryKey;
    staleTime: number;
    queryFn(context: { signal: AbortSignal }): Promise<T>;
  },
): Promise<T> {
  signal.throwIfAborted();
  const key = JSON.stringify(options.queryKey);
  const leave = () => {
    const left = (waiting.get(key) ?? 1) - 1;
    if (left > 0) waiting.set(key, left);
    else waiting.delete(key);
    return left;
  };
  const cancel = () => {
    if (leave() === 0) void cache.cancelQueries({ queryKey: options.queryKey, exact: true });
  };
  waiting.set(key, (waiting.get(key) ?? 0) + 1);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    return await cache.fetchQuery(options);
  } finally {
    if (!signal.aborted) leave();
    signal.removeEventListener("abort", cancel);
  }
}

/**
 * `@` and `#` for every Markdown editor inside: people and references of `repository` (the
 * project's own when not given), with `participants` (the PR's or issue's people, read when a
 * search runs, so they are as current as the page) first.
 */
export function ForgeCompletions(props: {
  workspaceId: string;
  repository?: ForgeRepository | undefined;
  participants(): readonly CompletionPerson[];
  children: ReactNode;
}) {
  const client = useClient();
  const cache = useQueryClient();
  const { workspaceId, repository, participants } = props;
  const repositoryKey = repository ? JSON.stringify(repository) : "";
  const value = useMemo((): MarkdownCompletions => {
    const scope = { workspaceId, ...(repository ? { repository } : {}) };
    // Every editor and picker under this provider shares it, so one search's cancel can't stop
    // a read another still waits for.
    const waiting = new Map<string, number>();
    return {
      async people(query, signal) {
        const q = searchable(query);
        const found = await fetchUntil(cache, waiting, signal, {
          queryKey: ["forge", workspaceId, repositoryKey, "people", q.toLowerCase()],
          staleTime: peopleFreshMs,
          queryFn: async ({ signal: reading }) => {
            const result = await readForge(
              client,
              { op: "forge.people", ...scope, query: q },
              reading,
            );
            return result.resource === "people" ? result.people : [];
          },
        })
          // Participants still answer when the repository's people can't be read.
          .catch(() => []);
        signal.throwIfAborted();
        return rankPeople(participants(), found, q);
      },
      async references(query, signal) {
        // GitHub matches whole words only: it is asked for the finished ones, and the word
        // still being typed narrows its answer here.
        const sent = searchable(referenceSearch(query));
        const found = await fetchUntil(cache, waiting, signal, {
          queryKey: ["forge", workspaceId, repositoryKey, "references", sent.toLowerCase()],
          staleTime: referencesFreshMs,
          queryFn: async ({ signal: reading }) => {
            const result = await readForge(
              client,
              { op: "forge.references", ...scope, query: sent },
              reading,
            );
            return result.resource === "references" ? result.references : [];
          },
        });
        const typed = searchable(query);
        return found.filter((reference) => referenceMatches(reference, typed));
      },
    };
    // `repositoryKey` stands for `repository`, which callers rebuild on every render.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [client, cache, workspaceId, repositoryKey, participants]);
  return <MarkdownCompletionsProvider value={value}>{props.children}</MarkdownCompletionsProvider>;
}
