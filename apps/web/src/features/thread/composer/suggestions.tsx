import { catalogDisplayName } from "@ace/ui-core";
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
  entry?: CatalogEntry | undefined;
}
export type Suggestions =
  | { state: "closed" }
  | { state: "ready"; kind: Trigger["kind"]; items: readonly Suggestion[]; refreshing?: boolean }
  | { state: "loading" | "empty"; kind: Trigger["kind"]; query: string }
  | { state: "failed"; kind: Trigger["kind"]; query: string; retry(): void };
const groups = {
  builtin: "Add",
  plugin: "Plugins",
  skill: "Skills",
  command: "Commands",
  agent: "Agents",
  workflow: "Workflows",
  "mcp-tool": "Tools",
};
const groupOrder = ["Add", "Plugins", "Skills", "Commands", "Agents", "Workflows", "Tools"];
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
): Suggestions {
  const sources = useThreadSources();
  const ready = useConnectionState() === "ready";
  const threads = useSidebarIndex(threadReference, sameThread) ?? [];
  const { id, provider, instanceId, workspaceId, draft } = thread;
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
  useEffect(() => {
    if (!scoped || !ready) return;
    return sources.commands.watch(
      reference,
      (entries, stale) => setCatalog({ reference, entries, stale, failed: false }),
      () => setCatalog({ reference, entries: [], stale: false, failed: true }),
    );
  }, [sources, scoped, ready, reference]);
  const mentions = useQuery({
    queryKey: ["thread", "mention", thread.id, trigger?.kind === "mention" ? trigger.query : ""],
    queryFn: ({ signal }) => sources.context.complete(thread, trigger?.query ?? "", signal),
    enabled: ready && scoped && trigger?.kind === "mention",
    staleTime: 10_000,
  });
  if (!trigger) return { state: "closed" };
  const { kind, query } = trigger;
  if (!scoped || !ready) return { state: "loading", kind, query };
  const q = query.toLowerCase();
  let items: Suggestion[];
  if (kind === "mention") {
    const lately = !query ? recent() : [];
    items = [...new Set([...lately, ...(mentions.data ?? [])])].map((path) => ({
      kind,
      group: "Files",
      insert: `@${path}`,
      label: path.slice(path.lastIndexOf("/") + 1),
      detail: path,
      path,
    }));
    items.push(
      ...threads
        .filter(
          (t) =>
            t.id !== thread.id &&
            t.workspaceId === thread.workspaceId &&
            t.title.toLowerCase().includes(q),
        )
        .slice(0, 8)
        .map((t) => ({
          kind,
          group: "Threads",
          insert: `@${t.title}`,
          label: t.title,
          detail: "Conversation in this project",
          threadId: t.id,
        })),
    );
    if (!items.length && mentions.isPending) return { state: "loading", kind, query };
    if (!items.length && mentions.isError)
      return { state: "failed", kind, query, retry: () => void mentions.refetch() };
  } else {
    if (!catalog || catalog.reference !== reference) return { state: "loading", kind, query };
    if (catalog.failed)
      return { state: "failed", kind, query, retry: () => setRevision((value) => value + 1) };
    if (catalog.stale && !catalog.entries.length) return { state: "loading", kind, query };
    const entries = thread.draft
      ? catalog.entries
      : [
          ...catalog.entries,
          {
            id: "ace:attachments",
            kind: "builtin",
            name: "Attachments",
            description: "Manage files stored for this thread",
            source: { provider: "ace", scope: "ace" },
            invocation: { type: "action", action: "attachments" },
          } satisfies CatalogEntry,
        ];
    const named = entries.filter(
      (entry) =>
        entry.name.toLowerCase().includes(q) || catalogDisplayName(entry).toLowerCase().includes(q),
    );
    items = (
      named.length ? named : entries.filter((entry) => entry.description.toLowerCase().includes(q))
    )
      .map((entry) => ({
        kind,
        group: groups[entry.kind],
        insert: entry.name,
        label: entry.kind === "builtin" ? entry.name : catalogDisplayName(entry),
        detail: entry.description,
        entry,
      }))
      .toSorted((a, b) => groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group));
    if (!items.length && catalog.stale) return { state: "loading", kind, query };
  }
  return items.length
    ? { state: "ready", kind, items, refreshing: kind === "command" && catalog?.stale === true }
    : { state: "empty", kind, query };
}
