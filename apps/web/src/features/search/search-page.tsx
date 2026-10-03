import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { cn } from "@/lib/cn.ts";
import { useDeferredValue, useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { ProviderMark } from "@/components/ui/provider-glyph.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { Screen } from "@/features/shell/screen.tsx";
import { formatAge, useNow } from "@/lib/time.ts";
import { useSearch, type SearchHit, type SearchKind } from "./search-source.ts";

export type KindFilter = "all" | SearchKind;
const filters = [
  { value: "all", label: "All" },
  { value: "message", label: "Messages" },
  { value: "tool_call", label: "Commands" },
  { value: "artifact", label: "Files" },
  { value: "thread", label: "Threads" },
] as const satisfies readonly { value: KindFilter; label: string }[];

const kindLabel: Record<SearchKind, string> = {
  thread: "Thread",
  message: "Message",
  tool_call: "Command",
  artifact: "File",
};

/** Plain text with highlighted ranges (half-open UTF-16 offsets) as <mark>. */
function Snippet(props: { snippet: SearchHit["snippet"] }) {
  const parts: { text: string; hit: boolean; at: number }[] = [];
  let at = 0;
  for (const range of props.snippet.highlights) {
    if (range.start > at)
      parts.push({ text: props.snippet.text.slice(at, range.start), hit: false, at });
    parts.push({
      text: props.snippet.text.slice(range.start, range.end),
      hit: true,
      at: range.start,
    });
    at = range.end;
  }
  if (at < props.snippet.text.length)
    parts.push({ text: props.snippet.text.slice(at), hit: false, at });
  return (
    <p className="mt-1 line-clamp-2 text-ui leading-normal text-muted-foreground">
      {parts.map((part) =>
        part.hit ? (
          <mark
            key={part.at}
            className="rounded-[3px] bg-accent px-0.5 font-medium text-foreground"
          >
            {part.text}
          </mark>
        ) : (
          <span key={part.at}>{part.text}</span>
        ),
      )}
    </p>
  );
}

/**
 * Search every thread. The query and filter live in the URL; ↑ and ↓ move through results
 * and Enter opens the thread.
 */
export function SearchPage(props: {
  query: string;
  kind: KindFilter;
  onChange(next: { q?: string | undefined; kind?: KindFilter }): void;
}) {
  const [text, setText] = useState(props.query);
  const deferred = useDeferredValue(text);
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const now = useNow();
  const results = useSearch(deferred, props.kind === "all" ? undefined : props.kind);
  const hits = deferred.trim() ? (results.data ?? []) : [];
  const open = (hit: SearchHit | undefined) =>
    hit && void navigate({ to: "/t/$threadId", params: { threadId: hit.threadId } });
  return (
    <Screen title="Search">
      <div className="h-full overflow-auto">
        <div className="mx-auto max-w-(--column) px-8 pt-11 pb-20">
          <label className="flex h-11 items-center gap-2.5 rounded-lg bg-secondary px-3.5 text-base focus-within:shadow-[0_0_0_2px_color-mix(in_oklab,var(--ring)_40%,transparent)]">
            <Icon icon={MagnifyingGlassIcon} className="text-subtle-foreground" />
            <input
              type="search"
              role="combobox"
              aria-label="Search every thread"
              aria-controls="search-results"
              aria-expanded={hits.length > 0}
              aria-activedescendant={hits[active] ? `search-hit-${active}` : undefined}
              placeholder="Search messages, commands and files"
              autoFocus
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setActive(0);
                props.onChange({ q: event.target.value || undefined });
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setActive((index) => Math.min(index + 1, Math.max(hits.length - 1, 0)));
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActive((index) => Math.max(index - 1, 0));
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  open(hits[active]);
                }
              }}
              className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-subtle-foreground"
            />
          </label>
          <SegmentedControl
            label="Kind"
            size="sm"
            value={props.kind}
            options={filters}
            onValueChange={(kind) => {
              setActive(0);
              props.onChange({ kind });
            }}
            className="mt-3"
          />
          {!deferred.trim() ? (
            <EmptyState
              icon={MagnifyingGlassIcon}
              title="Search every thread"
              description="Find a message, command or file across all projects and machines."
              className="h-auto pt-16"
            />
          ) : results.isError ? (
            <EmptyState
              title="Search unavailable"
              description={results.error.message}
              className="h-auto pt-16"
            />
          ) : !results.data ? null : !hits.length ? (
            <EmptyState
              icon={MagnifyingGlassIcon}
              title="No results"
              description="Every word has to appear. Try fewer or different words."
              className="h-auto pt-16"
            />
          ) : (
            <ul id="search-results" role="listbox" aria-label="Results" className="mt-5">
              {hits.map((hit, index) => (
                <li
                  key={`${hit.threadId}-${hit.kind}-${hit.createdAt}`}
                  id={`search-hit-${index}`}
                  role="option"
                  aria-selected={index === active}
                  className={cn(
                    "rounded-md transition-colors duration-150",
                    index === active && "bg-[color-mix(in_oklab,var(--foreground)_6%,transparent)]",
                  )}
                >
                  <Link
                    to="/t/$threadId"
                    params={{ threadId: hit.threadId }}
                    tabIndex={-1}
                    onMouseEnter={() => setActive(index)}
                    className="block px-3 py-2.5"
                  >
                    <span className="flex items-center gap-2 text-xs text-subtle-foreground">
                      <ProviderMark provider={hit.provider} />
                      {hit.workspaceId} · {kindLabel[hit.kind]}
                      <span className="ml-auto tabular-nums">{formatAge(hit.createdAt, now)}</span>
                    </span>
                    <span className="mt-0.5 block text-base font-medium">{hit.threadTitle}</span>
                    <Snippet snippet={hit.snippet} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Screen>
  );
}
