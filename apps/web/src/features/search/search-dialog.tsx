import { ClockCounterClockwiseIcon, MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import { useClient } from "@ace/client-react";
import { formatAge, resultCountLabel } from "@ace/ui-core";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { CommandDialog, commandField, CommandSearchRow } from "@/components/ui/command.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { ProviderIconTip } from "@/components/ui/provider-icons.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import { daemonErrorCode, describeDaemonError } from "@/lib/daemon-command.ts";
import { searchSettleMs, useDebouncedValue } from "@/lib/debounced.ts";
import { Select } from "@/components/ui/select.tsx";
import { WorkspaceId } from "@ace/protocol";
import { useProjectChoices } from "@/lib/projects.ts";
import { useNow } from "@/lib/time.ts";
import { useRecentSearches } from "./search-recent.ts";
import {
  hitSeq,
  SearchError,
  useSearch,
  type SearchHit,
  type SearchKind,
} from "./search-source.ts";

type KindFilter = "all" | SearchKind;
const filters = [
  { value: "all", label: "All" },
  { value: "message", label: "Messages" },
  { value: "tool_call", label: "Commands" },
  { value: "artifact", label: "Files" },
  { value: "thread", label: "Threads" },
] as const satisfies readonly { value: KindFilter; label: string }[];

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
    <p className="min-w-0 flex-1 line-clamp-2 break-words text-ui text-muted-foreground">
      {parts.map((part) =>
        part.hit ? (
          <mark key={part.at} className="rounded-[2px] bg-ring/22 font-medium text-foreground">
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
 * Search every thread, in a sheet over the current screen (the palette's, opened from the
 * sidebar's Search, ⇧⌘K or the palette's "Search all threads"). Typing settles for 180ms before
 * a search goes out. ↑ and ↓ move through results, Enter opens the thread at the hit (⌘↵ in a new
 * tab), and Esc closes the sheet.
 */
export default function SearchDialog(props: {
  open: boolean;
  /** The words it opens with. */
  query: string;
  onClose(): void;
}) {
  return (
    <CommandDialog
      open={props.open}
      onOpenChange={(open) => !open && props.onClose()}
      title="Search"
      className="search-glass"
      overlayClassName="bg-black/15"
      overlayStyle={{ backgroundColor: "rgb(0 0 0 / 15%)" }}
    >
      {props.open && <SearchBody initial={props.query} onClose={props.onClose} />}
    </CommandDialog>
  );
}

/** Mounted only while open, so a search in flight is dropped when the sheet closes. */
function SearchBody(props: { initial: string; onClose(): void }) {
  const [text, setText] = useState(props.initial);
  const [kind, setKind] = useState<KindFilter>("all");
  const settled = useDebouncedValue(text, searchSettleMs);
  // Clearing the field clears the results at once; only typing waits to settle.
  const query = text.trim() ? settled.trim() : "";
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const router = useRouter();
  const client = useClient();
  const now = useNow();
  const projects = useProjectChoices();
  const projectName = projects.name;
  const [project, setProject] = useState("");
  const [date, setDate] = useState("all");
  const [after, setAfter] = useState<number>();
  const recent = useRecentSearches();
  const results = useSearch(query, kind === "all" ? undefined : kind, {
    ...(project ? { workspaceId: WorkspaceId.parse(project) } : {}),
    ...(after === undefined ? {} : { after }),
  });
  const progress = results.progress;
  const indexing = progress && !progress.ready;
  const left = progress
    ? Math.max(0, progress.headSeq - progress.indexedSeq) + progress.pending
    : 0;
  const hits = query ? (results.hits ?? []) : [];

  // The active result stays in view as the arrows move it.
  useEffect(() => {
    document.getElementById(`search-hit-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const change = (next: string) => {
    setText(next);
    setActive(0);
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
    if (newTab) {
      globalThis.open?.(router.buildLocation(target).href, "_blank", "noopener");
      return;
    }
    props.onClose();
    void navigate(target);
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
    <>
      <CommandSearchRow closeLabel="Close search">
        <input
          type="text"
          role="combobox"
          aria-label="Search every thread"
          aria-controls="search-results"
          aria-expanded={hits.length > 0}
          aria-autocomplete="list"
          aria-activedescendant={hits[active] ? `search-hit-${active}` : undefined}
          placeholder="Search messages, commands and files"
          spellCheck={false}
          value={text}
          onChange={(event) => change(event.target.value)}
          onKeyDown={onKeyDown}
          className={commandField}
        />
        {results.updating && query && <Spinner label="Updating results" />}
      </CommandSearchRow>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <SegmentedControl
          label="Kind"
          size="sm"
          value={kind}
          options={filters}
          onValueChange={(next) => {
            setActive(0);
            setKind(next);
          }}
        />
        <Select
          label="Project"
          value={project}
          options={[
            { value: "", label: "All projects" },
            ...projects.ids.map((value) => ({ value, label: projectName(value) })),
          ]}
          className="min-w-0 flex-1"
          onValueChange={(value) => {
            setProject(value);
            setActive(0);
          }}
        />
        <Select
          label="Date"
          value={date}
          options={[
            { value: "all", label: "Any time" },
            { value: "1", label: "Past day" },
            { value: "7", label: "Past week" },
            { value: "30", label: "Past month" },
          ]}
          className="min-w-0 flex-1"
          onValueChange={(value) => {
            setDate(value);
            setAfter(value === "all" ? undefined : Math.max(0, now - Number(value) * 86_400_000));
            setActive(0);
          }}
        />
      </div>
      {(indexing || (query && hits.length > 0 && !results.isError)) && (
        <p role="status" className="px-3 pt-2 text-sm text-muted-foreground tabular-nums">
          {indexing
            ? `Indexing… ${left.toLocaleString()} left`
            : resultCountLabel(hits.length, results.hasMore, false)}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {!query ? (
          recent.recent.length ? (
            <RecentSearches recent={recent.recent} onPick={change} onForget={recent.forget} />
          ) : (
            <EmptyState
              icon={MagnifyingGlassIcon}
              title="Search every thread"
              description="Find a message, command or file across all projects and machines."
              className="h-auto py-10"
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
            className="h-auto py-10"
          />
        ) : !results.hits || (results.updating && !hits.length) ? (
          <ListSkeleton label="results" shape="row" rows={4} />
        ) : !hits.length ? (
          <EmptyState
            variant="inline"
            title={results.hasMore ? "More results to check" : "No matches yet"}
            description={
              indexing
                ? "Some threads are still being indexed. Results will update as they become available."
                : results.hasMore
                  ? "Keep looking through the remaining results."
                  : "Try fewer words or broaden the project and date filters."
            }
            className="py-6"
          />
        ) : (
          <>
            <ul
              id="search-results"
              role="listbox"
              aria-label="Results"
              className={cn(
                "transition-opacity duration-(--dur-1)",
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
                    "flex min-h-9 cursor-pointer items-start gap-2 py-2 rounded-md px-2.5 transition-colors duration-(--dur-1)",
                    index === active && "bg-accent",
                  )}
                >
                  <ProviderIconTip provider={hit.provider} />
                  <div className="min-w-0 flex-1">
                    {hit.kind !== "thread" && (
                      <p className="line-clamp-2 text-ui">{hit.threadTitle}</p>
                    )}
                    <Snippet snippet={hit.snippet} />
                  </div>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                    {formatAge(hit.createdAt, now)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        {results.hasMore && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-1"
            disabled={results.loadingMore}
            onClick={results.loadMore}
          >
            {results.loadingMore ? "Loading…" : "Show more results"}
          </Button>
        )}
      </div>
    </>
  );
}

function RecentSearches(props: {
  recent: readonly string[];
  onPick(query: string): void;
  onForget(query: string): void;
}) {
  return (
    <section aria-labelledby="search-recent">
      <h2
        id="search-recent"
        className="px-2.5 pt-1 pb-1.5 text-sm font-medium text-muted-foreground"
      >
        Recent
      </h2>
      <ul className="flex flex-col gap-px">
        {props.recent.map((query) => (
          <li key={query} className="group flex items-center gap-1 rounded-md hover:bg-accent">
            <button
              type="button"
              onClick={() => props.onPick(query)}
              className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-ui focus-ring-inset"
            >
              <Icon icon={ClockCounterClockwiseIcon} className="text-muted-foreground" />
              <span className="truncate">{query}</span>
            </button>
            <IconButton
              icon={XIcon}
              size="sm"
              label={`Forget "${query}"`}
              className="mr-1.5"
              onClick={() => props.onForget(query)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
