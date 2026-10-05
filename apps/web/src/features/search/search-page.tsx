import { ClockCounterClockwiseIcon, MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import { useClient } from "@ace/client-react";
import { formatAge, resultCountLabel } from "@ace/ui-core";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Icon } from "@/components/icon.tsx";
import { SearchField } from "@/components/search-field.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { ProviderIconTip } from "@/components/ui/provider-icons.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Screen } from "@/features/shell/index.ts";
import { cn } from "@/lib/cn.ts";
import { daemonErrorCode, describeDaemonError } from "@/lib/daemon-command.ts";
import { searchSettleMs, useDebouncedValue } from "@/lib/debounced.ts";
import { useProjectName } from "@/lib/projects.ts";
import { useNow } from "@/lib/time.ts";
import { useRecentSearches } from "./search-recent.ts";
import {
  hitSeq,
  SearchError,
  useSearch,
  type SearchHit,
  type SearchKind,
} from "./search-source.ts";

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

/** One key per hit: the item (or the thread, for a title) and what kind of hit it is. */
const hitKey = (hit: SearchHit) => `${hit.itemId ?? hit.threadId}\u0000${hit.kind}`;

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
            className="rounded-[2px] bg-[color-mix(in_oklab,var(--ring)_22%,transparent)] font-medium text-foreground"
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
 * Search every thread. The query and filter live in the URL; typing settles for 180ms before
 * a search goes out. ↑ and ↓ move through results, Enter opens the thread at the hit (⌘↵ in a
 * new tab), and Esc clears the field, then leaves it.
 */
export function SearchPage(props: {
  query: string;
  kind: KindFilter;
  onChange(next: { q?: string | undefined; kind?: KindFilter }): void;
}) {
  const [text, setText] = useState(props.query);
  const settled = useDebouncedValue(text, searchSettleMs);
  // Clearing the field clears the results at once; only typing waits to settle.
  const query = text.trim() ? settled.trim() : "";
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const router = useRouter();
  const client = useClient();
  const now = useNow();
  const projectName = useProjectName();
  const recent = useRecentSearches();
  const results = useSearch(query, props.kind === "all" ? undefined : props.kind);
  const hits = query ? (results.hits ?? []) : [];

  // The active result stays in view as the arrows move it.
  useEffect(() => {
    document.getElementById(`search-hit-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const change = (next: string) => {
    setText(next);
    setActive(0);
    props.onChange({ q: next || undefined });
  };
  /** Into the thread at the hit: its sequence when the thread can say, and the words. */
  const open = async (hit: SearchHit | undefined, newTab = false) => {
    if (!hit) return;
    recent.remember(query);
    const seq = await hitSeq(client, hit, query);
    const target = {
      to: "/t/$threadId" as const,
      params: { threadId: hit.threadId },
      search: { ...(seq === undefined ? {} : { seq }), ...(query ? { q: query } : {}) },
    };
    if (newTab) globalThis.open?.(router.buildLocation(target).href, "_blank", "noopener");
    else void navigate(target);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, Math.max(hits.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      void open(hits[active], event.metaKey || event.ctrlKey);
    }
  };
  const onHitClick = (event: MouseEvent, hit: SearchHit) =>
    void open(hit, event.metaKey || event.ctrlKey || event.button === 1);

  return (
    <Screen title="Search">
      <div className="h-full overflow-auto">
        <div className="mx-auto max-w-(--column) px-4 pt-6 pb-20 sm:px-8 sm:pt-11">
          <SearchField
            size="lg"
            label="Search every thread"
            role="combobox"
            aria-controls="search-results"
            aria-expanded={hits.length > 0}
            aria-activedescendant={hits[active] ? `search-hit-${active}` : undefined}
            placeholder="Search messages, commands and files"
            autoFocus
            value={text}
            onValueChange={change}
            onKeyDown={onKeyDown}
            trailing={results.updating && query ? <Spinner label="Updating results" /> : null}
          />
          <div className="mt-3 flex items-center gap-3">
            <SegmentedControl
              label="Kind"
              size="sm"
              value={props.kind}
              options={filters}
              onValueChange={(kind) => {
                setActive(0);
                props.onChange({ kind });
              }}
            />
            {query && hits.length > 0 && !results.isError && (
              <span role="status" className="ml-auto text-sm text-muted-foreground tabular-nums">
                {resultCountLabel(hits.length, results.hasMore, false)}
              </span>
            )}
          </div>
          {!query ? (
            recent.recent.length ? (
              <RecentSearches recent={recent.recent} onPick={change} onForget={recent.forget} />
            ) : (
              <EmptyState
                icon={MagnifyingGlassIcon}
                title="Search every thread"
                description="Find a message, command or file across all projects and machines."
                className="h-auto pt-16"
              />
            )
          ) : results.isError ? (
            <EmptyState
              icon={MagnifyingGlassIcon}
              title="Search unavailable"
              description={
                results.error instanceof SearchError
                  ? results.error.message
                  : describeDaemonError(daemonErrorCode(results.error))
              }
              action={
                <Button size="sm" onClick={() => void results.refetch()}>
                  Try again
                </Button>
              }
              className="h-auto pt-16"
            />
          ) : !results.hits ? (
            <ListSkeleton label="results" shape="row" rows={4} className="mt-5" />
          ) : !hits.length ? (
            <EmptyState
              icon={MagnifyingGlassIcon}
              title="No results"
              description="Every word has to appear. Try fewer or different words."
              className="h-auto pt-16"
            />
          ) : (
            <>
              <ul
                id="search-results"
                role="listbox"
                aria-label="Results"
                className={cn(
                  "mt-4 transition-opacity duration-(--dur-1)",
                  results.updating && "opacity-60",
                )}
              >
                {hits.map((hit, index) => (
                  <li
                    key={hitKey(hit)}
                    id={`search-hit-${index}`}
                    role="option"
                    aria-selected={index === active}
                    onMouseEnter={() => setActive(index)}
                    onClick={(event) => onHitClick(event, hit)}
                    onAuxClick={(event) => event.button === 1 && onHitClick(event, hit)}
                    className={cn(
                      "cursor-pointer scroll-my-2 rounded-md px-3 py-2.5 transition-colors duration-(--dur-1)",
                      index === active &&
                        "bg-[color-mix(in_oklab,var(--foreground)_6%,transparent)]",
                    )}
                  >
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      <ProviderIconTip provider={hit.provider} />
                      {projectName(hit.workspaceId)} · {kindLabel[hit.kind]}
                      <span className="ml-auto tabular-nums">{formatAge(hit.createdAt, now)}</span>
                    </span>
                    <span className="mt-0.5 block text-base font-medium">{hit.threadTitle}</span>
                    <Snippet snippet={hit.snippet} />
                  </li>
                ))}
              </ul>
              {results.hasMore && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2"
                  disabled={results.loadingMore}
                  onClick={results.loadMore}
                >
                  {results.loadingMore ? "Loading…" : "Show more results"}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </Screen>
  );
}

function RecentSearches(props: {
  recent: readonly string[];
  onPick(query: string): void;
  onForget(query: string): void;
}) {
  return (
    <section aria-labelledby="search-recent" className="mt-6">
      <h2 id="search-recent" className="px-3 pb-1.5 text-sm font-medium text-muted-foreground">
        Recent
      </h2>
      <ul className="flex flex-col gap-px">
        {props.recent.map((query) => (
          <li key={query} className="group flex items-center gap-1 rounded-md hover:bg-accent">
            <button
              type="button"
              onClick={() => props.onPick(query)}
              className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-3 py-2 text-left text-ui focus-ring-inset"
            >
              <Icon icon={ClockCounterClockwiseIcon} className="text-muted-foreground" />
              <span className="truncate">{query}</span>
            </button>
            <IconButton
              icon={XIcon}
              size="sm"
              label={`Forget "${query}"`}
              tooltip={false}
              className="mr-1.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
              onClick={() => props.onForget(query)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
