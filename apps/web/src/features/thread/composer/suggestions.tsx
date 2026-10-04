import { useQuery } from "@tanstack/react-query";
import { matchCommands } from "../sources/command-source.ts";
import { useThreadSources, type ThreadRef } from "../sources/index.ts";
import type { Trigger } from "./draft.ts";

export interface Suggestion {
  /** Text inserted in place of the token, e.g. "@src/app.tsx" or "/review". */
  insert: string;
  label: string;
  detail?: string | undefined;
  kind: Trigger["kind"];
  path?: string | undefined;
}

/** What the list above the composer shows for the token being typed. */
export type Suggestions =
  | { state: "closed" }
  | { state: "ready"; kind: Trigger["kind"]; items: readonly Suggestion[] }
  | { state: "loading" | "empty" | "failed"; kind: Trigger["kind"]; query: string };

const closed: Suggestions = { state: "closed" };

/** File paths for `@`, slash commands for a leading `/`. One-off reads, cached briefly. */
export function useSuggestions(thread: ThreadRef, trigger: Trigger | undefined): Suggestions {
  const sources = useThreadSources();
  // A draft the daemon hasn't granted a scope yet has nothing to search.
  const scoped = !thread.draft || !!thread.id;
  const mentions = useQuery({
    queryKey: ["thread", "mention", thread.id, trigger?.kind === "mention" ? trigger.query : ""],
    queryFn: ({ signal }) => sources.context.complete(thread, trigger?.query ?? "", signal),
    enabled: scoped && trigger?.kind === "mention",
    staleTime: 10_000,
  });
  const commands = useQuery({
    queryKey: ["thread", "slash-commands", thread.id, thread.provider, thread.instanceId],
    queryFn: ({ signal }) => sources.commands.commands(thread, signal),
    enabled: scoped && trigger?.kind === "command",
    staleTime: 60_000,
  });
  if (!trigger) return closed;
  const { kind, query } = trigger;
  const read = kind === "mention" ? mentions : commands;
  if (!scoped || read.isPending) return { state: "loading", kind, query };
  if (read.isError) return { state: "failed", kind, query };
  const items: Suggestion[] =
    kind === "mention"
      ? (mentions.data ?? []).map((path) => ({
          kind,
          insert: `@${path}`,
          label: path.slice(path.lastIndexOf("/") + 1),
          detail: path,
          path,
        }))
      : matchCommands(commands.data ?? [], query).map((command) => ({
          kind,
          insert: `/${command.name}`,
          label: `/${command.name}`,
          detail: command.description,
        }));
  return items.length ? { state: "ready", kind, items } : { state: "empty", kind, query };
}
