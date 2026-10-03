import { FileIcon, CommandIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
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

const empty: readonly Suggestion[] = [];

/** File paths for `@`, slash commands for a leading `/`. One-off reads, cached briefly. */
export function useSuggestions(
  thread: ThreadRef,
  trigger: Trigger | undefined,
): readonly Suggestion[] {
  const sources = useThreadSources();
  const mentions = useQuery({
    queryKey: ["thread", "mention", thread.id, trigger?.kind === "mention" ? trigger.query : ""],
    queryFn: ({ signal }) => sources.context.complete(thread, trigger?.query ?? "", signal),
    enabled: trigger?.kind === "mention",
    staleTime: 10_000,
  });
  const commands = useQuery({
    queryKey: ["thread", "slash-commands", thread.id],
    queryFn: () => sources.commands.commands(thread),
    enabled: trigger?.kind === "command",
    staleTime: 60_000,
  });
  if (!trigger) return empty;
  if (trigger.kind === "mention")
    return (mentions.data ?? []).map((path) => ({
      kind: "mention",
      insert: `@${path}`,
      label: path.slice(path.lastIndexOf("/") + 1),
      detail: path,
      path,
    }));
  return matchCommands(commands.data ?? [], trigger.query).map((command) => ({
    kind: "command",
    insert: `/${command.name}`,
    label: `/${command.name}`,
    detail: command.description,
  }));
}

/** The list above the composer. The textarea keeps focus and drives it with the arrow keys. */
export function SuggestionList(props: {
  id: string;
  items: readonly Suggestion[];
  active: number;
  onPick(item: Suggestion): void;
}) {
  if (!props.items.length) return null;
  const kind = props.items[0]?.kind;
  return (
    <div className="glass absolute inset-x-0 bottom-full z-20 mb-2 rounded-lg p-1.5">
      <p className="px-2.5 pt-1 pb-1 text-[11px] font-medium tracking-[0.02em] text-subtle-foreground">
        {kind === "mention" ? "Files" : "Commands"}
      </p>
      <ul id={props.id} role="listbox" aria-label={kind === "mention" ? "Files" : "Commands"}>
        {props.items.map((item, index) => (
          <li
            key={item.insert}
            id={`${props.id}-${index}`}
            role="option"
            aria-selected={index === props.active}
            // Keep the textarea focused: pick on mousedown, before blur.
            onMouseDown={(event) => {
              event.preventDefault();
              props.onPick(item);
            }}
            className={cn(
              "flex h-[30px] cursor-default items-center gap-[9px] rounded-md px-2.5 text-ui",
              index === props.active && "bg-accent",
            )}
          >
            {item.kind === "mention" ? (
              <FileIcon aria-hidden size={14} className="shrink-0 text-muted-foreground" />
            ) : (
              <CommandIcon aria-hidden size={14} className="shrink-0 text-muted-foreground" />
            )}
            <span className={cn("shrink-0", item.kind === "command" && "font-mono text-[12.5px]")}>
              {item.label}
            </span>
            {item.detail && (
              <span
                className={cn(
                  "min-w-0 truncate text-xs text-subtle-foreground",
                  item.kind === "mention" && "font-mono",
                )}
              >
                {item.detail}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
