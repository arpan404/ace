import { MentionIcon } from "@/components/mention-chip.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import type { Suggestion, Suggestions } from "./suggestions.tsx";

export function SuggestionList(props: {
  id: string;
  suggestions: Suggestions;
  active: number;
  onPick(item: Suggestion): void;
}) {
  const { suggestions } = props;
  if (suggestions.state === "closed") return null;
  const title = suggestions.kind === "mention" ? "Files and threads" : "Add and commands";
  return (
    <div className="absolute inset-x-0 bottom-full z-20 mb-2 max-h-[min(420px,50dvh)] overflow-y-auto rounded-xl border bg-popover p-1.5 shadow-[var(--glass-shadow)]">
      {suggestions.state === "ready" ? (
        <ul id={props.id} role="listbox" aria-label={title}>
          {suggestions.items.map((item, index) => (
            <li key={item.entry?.id ?? item.threadId ?? item.insert} role="presentation">
              {(index === 0 || suggestions.items[index - 1]?.group !== item.group) && (
                <p className="px-2.5 py-1 text-xs text-subtle-foreground">{item.group}</p>
              )}
              <div
                id={`${props.id}-${index}`}
                role="option"
                aria-label={[
                  item.label,
                  item.detail,
                  item.entry?.source.scope === "project"
                    ? "Project"
                    : item.entry?.source.scope === "global"
                      ? "Global"
                      : undefined,
                ]
                  .filter(Boolean)
                  .join(" ")}
                aria-selected={index === props.active}
                aria-disabled={item.entry?.invocation.type === "unavailable" || undefined}
                ref={(el) => {
                  if (el && index === props.active) el.scrollIntoView?.({ block: "nearest" });
                }}
                onMouseDown={(event) => {
                  event.preventDefault();
                  props.onPick(item);
                }}
                className={cn(
                  "flex h-9 cursor-default items-center gap-2 rounded-md px-2.5 text-ui leading-4",
                  index === props.active && "bg-accent",
                )}
              >
                <MentionIcon
                  kind={item.entry?.kind ?? (item.threadId ? "thread" : "file")}
                  action={
                    item.entry?.invocation.type === "action"
                      ? item.entry.invocation.action
                      : undefined
                  }
                />
                <span className="min-w-0 shrink truncate">{item.label}</span>
                {item.detail && (
                  <span className="min-w-0 flex-1 truncate text-xs text-subtle-foreground">
                    {item.detail}
                  </span>
                )}
                {item.entry && item.entry.source.scope !== "ace" && (
                  <span className="shrink-0 text-[11px] text-subtle-foreground">
                    {item.entry.source.scope === "project"
                      ? "Project"
                      : item.entry.source.scope === "global"
                        ? "Global"
                        : (item.entry.source.plugin ?? "Plugin")}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p
          role="status"
          className="flex h-9 items-center gap-2 px-2.5 text-ui text-muted-foreground"
        >
          {suggestions.state === "loading" && <Spinner />}
          {suggestions.state === "loading"
            ? "Loading suggestions…"
            : suggestions.state === "failed"
              ? "Couldn't load suggestions. Close the menu and try again."
              : "No matching suggestions"}
        </p>
      )}
    </div>
  );
}
