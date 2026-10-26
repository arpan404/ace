import { commandSuggestions, mentionSuggestions } from "@ace/ui-core";
import { useMentionTabs, type MentionTab } from "@/features/panels/index.ts";
import { useConnectionState, useSidebarIndex } from "@ace/client-react";
import type { CatalogEntry, ThreadListEntry } from "@ace/protocol";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useThreadSources, type ThreadRef } from "../sources/index.ts";
import type { Trigger } from "./draft.ts";

export interface Suggestion {
  insert: string;
  label: string;
  detail?: string | undefined;
  kind: Trigger["kind"];
  group: string;
  path?: string | undefined;
  threadId?: string | undefined;
  /** A tab of this thread's browser. */
  tab?: MentionTab | undefined;
  entry?: CatalogEntry | undefined;
}
export type Suggestions = (
  | { state: "closed" }
  | { state: "ready"; kind: Trigger["kind"]; items: readonly Suggestion[]; refreshing?: boolean }
  | { state: "loading" | "empty"; kind: Trigger["kind"]; query: string }
  | { state: "failed"; kind: Trigger["kind"]; query: string; retry(): void }
) & {
  /** The current catalog, for resolving a `/name` typed without picking from the menu. */
  entries?: readonly CatalogEntry[] | undefined;
};
const threadReference = (thread: ThreadListEntry) => ({
  id: thread.id,
  title: thread.title,
  workspaceId: thread.workspaceId,
});
const sameThread = (a: ReturnType<typeof threadReference>, b: ReturnType<typeof threadReference>) =>
  a.id === b.id && a.title === b.title && a.workspaceId === b.workspaceId;
export function useSuggestions(
  thread: ThreadRef,
  trigger: Trigger | undefined,
  recent: () => readonly string[],
  adding = false,
): Suggestions {
  const sources = useThreadSources();
  const ready = useConnectionState() === "ready";
  const threads = useSidebarIndex(threadReference, sameThread) ?? [];
  const { id, provider, instanceId, workspaceId, draft } = thread;
  const tabs = useMentionTabs(draft ? undefined : id, trigger?.kind === "mention");
  const [revision, setRevision] = useState(0);
  const reference = useMemo(
    () => ({ id, provider, instanceId, workspaceId, draft, revision }),
    [id, provider, instanceId, workspaceId, draft, revision],
  );
  const [catalog, setCatalog] = useState<{
    reference: typeof reference;
    entries: readonly CatalogEntry[];
    failed: boolean;
    stale: boolean;
  }>();
  const scoped = !thread.draft || !!thread.id;
  const commandOpen = trigger?.kind === "command";
  const retryScope = thread.retryDraftScope;
  useEffect(() => {
    if (commandOpen && draft && provider && !id) retryScope?.();
  }, [commandOpen, draft, provider, id, retryScope]);
  useEffect(() => {
    // Discover before typing, then re-watch when the menu opens so failed reads can recover.
    if (!scoped || !ready || (draft && !provider)) return;
    return sources.commands.watch(
      reference,
      (entries, stale) => setCatalog({ reference, entries, stale, failed: false }),
      () => setCatalog({ reference, entries: [], stale: false, failed: true }),
    );
    // Opening the menu retries discovery even when its target is unchanged.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [sources, scoped, ready, reference, commandOpen, draft, provider]);
  const mentions = useQuery({
    queryKey: ["thread", "mention", thread.id, trigger?.kind === "mention" ? trigger.query : ""],
    queryFn: ({ signal }) => sources.context.complete(thread, trigger?.query ?? "", signal),
    enabled: ready && scoped && trigger?.kind === "mention",
    staleTime: 10_000,
  });
  const known =
    catalog && catalog.reference === reference && !catalog.failed ? catalog.entries : undefined;
  if (!trigger) return { state: "closed", entries: known };
  const { kind, query } = trigger;
  if (!scoped || !ready) return { state: "loading", kind, query };
  let items: Suggestion[];
  if (kind === "mention") {
    items = mentionSuggestions({
      query,
      recent: query ? [] : recent(),
      paths: mentions.data ?? [],
      tabs,
      threads,
      threadId: thread.id,
      workspaceId: thread.workspaceId,
    }).map((item) => ({
      ...item,
      kind,
      insert: item.path ? `@${item.path}` : `@${item.label}`,
    }));
    if (!items.length && mentions.isPending) return { state: "loading", kind, query };
    if (!items.length && mentions.isError)
      return { state: "failed", kind, query, retry: () => void mentions.refetch() };
  } else {
    if (!catalog || catalog.reference !== reference) return { state: "loading", kind, query };
    if (catalog.failed)
      return { state: "failed", kind, query, retry: () => setRevision((value) => value + 1) };
    if (catalog.stale && !catalog.entries.length) return { state: "loading", kind, query };
    items = commandSuggestions(catalog.entries, {
      query,
      provider,
      draft: !!thread.draft,
      adding,
    }).map((item) => ({ ...item, kind, insert: item.entry?.name ?? item.label }));
    if (!items.length && catalog.stale) return { state: "loading", kind, query };
  }
  return items.length
    ? { state: "ready", kind, items, refreshing: kind === "command" && catalog?.stale === true }
    : { state: "empty", kind, query, entries: known };
}
