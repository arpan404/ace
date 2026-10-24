import { useMemo, type ReactNode } from "react";
import { useClient } from "@ace/client-react";
import { useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import type { ForgeIssueDetail, ForgePrDetail, ForgeRepository } from "@ace/protocol";
import {
  MarkdownCompletionsProvider,
  type CompletionPerson,
  type MarkdownCompletions,
} from "@/components/markdown-editor/completion-source.ts";
import { referenceMatches, referenceSearch } from "@/components/markdown-editor/completions.ts";
import { readForge } from "@/lib/forge-read.ts";

/** How long a search's answer is reused: who can be mentioned rarely changes. */
const peopleFreshMs = 5 * 60_000;
const referencesFreshMs = 60_000;
const most = 8;

/**
 * A search as the protocol accepts it (`ForgeCompletionQuery`): anything else becomes a space,
 * so `acme/docs` searches `acme docs` and no search qualifier reaches GitHub. The one sanitizer
 * before the wire.
 */
export function searchable(query: string): string {
  return query
    .replace(/[^\w .-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

function matches(person: CompletionPerson, query: string): boolean {
  const q = query.toLowerCase();
  return (
    !q ||
    person.login.toLowerCase().includes(q) ||
    (person.name?.toLowerCase().includes(q) ?? false)
  );
}

/**
 * `@` suggestions in GitHub's order: the conversation's own people first (in the order given),
 * then the repository's others, each person once.
 */
export function rankPeople(
  participants: readonly CompletionPerson[],
  found: readonly CompletionPerson[],
  query: string,
): CompletionPerson[] {
  const seen = new Map<string, CompletionPerson>();
  for (const person of [...participants.filter((p) => matches(p, query)), ...found]) {
    const key = person.login.toLowerCase();
    const known = seen.get(key);
    // A search result may know the name and picture a participant's entry lacks.
    seen.set(
      key,
      known
        ? {
            ...person,
            ...known,
            name: known.name ?? person.name,
            avatarUrl: known.avatarUrl ?? person.avatarUrl,
          }
        : person,
    );
  }
  return [...seen.values()].slice(0, most);
}

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

function people(entries: readonly (readonly [string, string | undefined])[]): CompletionPerson[] {
  const seen = new Set<string>();
  return entries.flatMap(([login, avatarUrl]) => {
    const key = login.toLowerCase();
    if (!login || seen.has(key)) return [];
    seen.add(key);
    return [{ login, ...(avatarUrl ? { avatarUrl } : {}) }];
  });
}

/** A pull request's people: its author, reviewers, then whoever commented, latest first. */
export function prParticipants(detail: ForgePrDetail): CompletionPerson[] {
  const comments = detail.status.comments.toSorted((a, b) =>
    (b.createdAt ?? b.updatedAt).localeCompare(a.createdAt ?? a.updatedAt),
  );
  return people([
    [detail.author, detail.authorAvatarUrl],
    ...detail.reviewers.map((login) => [login, detail.reviewerAvatars?.[login]] as const),
    ...comments.map((c) => [c.author, c.authorAvatarUrl] as const),
  ]);
}

/** An issue's people: its author, assignees, then whoever spoke in it, latest first. */
export function issueParticipants(
  issue: ForgeIssueDetail,
  actors: readonly string[],
): CompletionPerson[] {
  return people([
    [issue.author, issue.authorAvatarUrl ?? issue.avatars?.[issue.author]],
    ...issue.assignees.map((login) => [login, issue.avatars?.[login]] as const),
    ...actors.toReversed().map((login) => [login, issue.avatars?.[login]] as const),
  ]);
}
