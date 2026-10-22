import { useMemo, type ReactNode } from "react";
import { useClient } from "@ace/client-react";
import { useQueryClient } from "@tanstack/react-query";
import type { ForgeIssueDetail, ForgePrDetail, ForgeRepository } from "@ace/protocol";
import {
  MarkdownCompletionsProvider,
  type CompletionPerson,
  type MarkdownCompletions,
} from "@/components/markdown-editor/completion-source.ts";
import { readForge } from "@/lib/forge-read.ts";

/** How long a search's answer is reused: who can be mentioned rarely changes. */
const peopleFreshMs = 5 * 60_000;
const referencesFreshMs = 60_000;
const most = 8;

/** Searches go to GitHub with what its search accepts; anything else is left out. */
const searchable = (query: string) => query.replace(/[^\w .-]/g, "").slice(0, 100);

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
 * `@` and `#` for every Markdown editor inside: people and references of `repository` (the
 * project's own when not given), with `participants` (the PR's or issue's people) first.
 */
export function ForgeCompletions(props: {
  workspaceId: string;
  repository?: ForgeRepository | undefined;
  participants: readonly CompletionPerson[];
  children: ReactNode;
}) {
  const client = useClient();
  const cache = useQueryClient();
  const { workspaceId, repository, participants } = props;
  const repositoryKey = repository ? JSON.stringify(repository) : "";
  const value = useMemo((): MarkdownCompletions => {
    const scope = { workspaceId, ...(repository ? { repository } : {}) };
    return {
      async people(query) {
        const q = searchable(query);
        const found = await cache
          .fetchQuery({
            queryKey: ["forge", workspaceId, repositoryKey, "people", q.toLowerCase()],
            staleTime: peopleFreshMs,
            queryFn: async ({ signal }) => {
              const result = await readForge(
                client,
                { op: "forge.people", ...scope, query: q },
                signal,
              );
              return result.resource === "people" ? result.people : [];
            },
          })
          // Participants still answer when the repository's people can't be read.
          .catch(() => []);
        return rankPeople(participants, found, q);
      },
      async references(query) {
        const q = searchable(query);
        return cache.fetchQuery({
          queryKey: ["forge", workspaceId, repositoryKey, "references", q.toLowerCase()],
          staleTime: referencesFreshMs,
          queryFn: async ({ signal }) => {
            const result = await readForge(
              client,
              { op: "forge.references", ...scope, query: q },
              signal,
            );
            return result.resource === "references" ? result.references : [];
          },
        });
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
