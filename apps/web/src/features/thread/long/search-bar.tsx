import { useClient } from "@ace/client-react";
import { indexingLabel, resultCountLabel, snippetRuns } from "@ace/ui-core";
import { CaretDownIcon, CaretUpIcon, MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { LongRows } from "@/components/virtual-rows.tsx";
import { cn } from "@/lib/cn.ts";
import type { ThreadNav } from "./nav.tsx";
import { ThreadSearch, type SearchFilter, type SearchHit } from "./search-state.ts";
import { useTranscriptHighlight } from "./search-highlight.ts";

const filters: readonly { value: SearchFilter | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "messages", label: "Messages" },
  { value: "tool_output", label: "Tool output" },
  { value: "commands", label: "Commands" },
  { value: "files", label: "Files" },
  { value: "errors", label: "Errors" },
];
/** Typing settles this long before a query goes out. */
const settleMs = 180;

/**
 * ⌘F: search this thread (and, with Subagents on, its linked subagent threads). Results list
 * the hit's turn and snippet with the match marked; Enter and Shift+Enter (or the arrows) step
 * through them, jumping the transcript to each and marking the words in it.
 */
export function SearchBar(props: { nav: ThreadNav }) {
  const { nav } = props;
  const client = useClient();
  const navigate = useNavigate();
  const [search] = useState(() => new ThreadSearch(client, nav.threadId));
  useEffect(() => () => search.dispose(), [search]);
  const state = useSyncExternalStore(search.subscribe, search.snapshot, search.snapshot);
  const [text, setText] = useState("");
  const [filter, setFilter] = useState<SearchFilter | "all">("all");
  const [tree, setTree] = useState(false);
  const [active, setActive] = useState(-1);
  // The list folds away once the reader steps to a hit, so the hit shows under the bar.
  const [listOpen, setListOpen] = useState(true);
  const input = useRef<HTMLInputElement>(null);
  // ⌘F focuses the field, now and whenever it is pressed again while the bar is open.
  useEffect(() => {
    const focus = () => {
      input.current?.focus();
      input.current?.select();
    };
    focus();
    return nav.searchFocus.subscribe(focus);
  }, [nav.searchFocus]);
  useEffect(() => {
    const timer = setTimeout(
      () => search.search({ text, filter: filter === "all" ? undefined : filter, tree }),
      settleMs,
    );
    return () => clearTimeout(timer);
  }, [search, text, filter, tree]);
  const query = state.query?.text;
  useTranscriptHighlight(query);
  // A new query starts from its first hit.
  const [shownQuery, setShownQuery] = useState(state.query);
  if (shownQuery !== state.query) {
    setShownQuery(state.query);
    setActive(-1);
  }

  const open = (hit: SearchHit, index: number) => {
    setActive(index);
    setListOpen(false);
    if (hit.threadId === nav.threadId)
      void nav.jump.toSeq(hit.seq, { turn: hit.turnOrdinal, ...(query ? { query } : {}) });
    else
      void navigate({
        to: "/t/$threadId",
        params: { threadId: hit.threadId },
        search: { seq: hit.seq, ...(query ? { q: query } : {}) },
      });
  };
  const step = (delta: 1 | -1) => {
    const count = state.hits.length;
    if (!count) return;
    const next = active < 0 ? (delta === 1 ? 0 : count - 1) : (active + delta + count) % count;
    const hit = state.hits[next];
    if (hit) open(hit, next);
    // Stepping near the end of what is loaded reads on.
    if (next >= count - 5 && state.more) void search.more();
  };
  const close = () => {
    nav.setSearchOpen(false);
  };
  const count = resultCountLabel(state.hits.length, state.more, state.loading);
  const indexing = indexingLabel(state.pending);
  const showList = listOpen && !!query && (state.hits.length > 0 || !state.loading);

  return (
    <div
      role="search"
      aria-label="Search this thread"
      style={{ pointerEvents: "auto" }}
      // Esc closes from anywhere in the bar: the field, a filter, the subagent switch.
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
      className="glass fx-rise-in flex w-[min(620px,calc(100vw-2rem))] flex-col rounded-lg shadow-[var(--glass-shadow)]"
    >
      <div className="flex h-11 items-center gap-2 pr-1.5 pl-3">
        <MagnifyingGlassIcon aria-hidden size={16} className="shrink-0 text-subtle-foreground" />
        <input
          ref={input}
          aria-label="Search this thread"
          placeholder="Search this thread"
          value={text}
          spellCheck={false}
          onChange={(event) => {
            setText(event.target.value);
            setListOpen(true);
          }}
          onClick={() => setListOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              step(event.shiftKey ? -1 : 1);
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              step(event.key === "ArrowDown" ? 1 : -1);
            }
          }}
          className="h-full min-w-0 flex-1 bg-transparent text-ui text-foreground outline-none placeholder:text-subtle-foreground"
        />
        <span aria-live="polite" className="shrink-0 text-xs tabular-nums text-subtle-foreground">
          {query ? (active >= 0 && state.hits.length ? `${active + 1} of ${count}` : count) : ""}
        </span>
        {state.loading && <Spinner />}
        <IconButton
          icon={CaretUpIcon}
          label="Previous result"
          size="sm"
          disabled={!state.hits.length}
          onClick={() => step(-1)}
        />
        <IconButton
          icon={CaretDownIcon}
          label="Next result"
          size="sm"
          disabled={!state.hits.length}
          onClick={() => step(1)}
        />
        <IconButton icon={XIcon} label="Close search" size="sm" onClick={close} />
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border px-2 py-1.5">
        <div
          role="group"
          aria-label="Search in"
          className="inline-flex gap-0.5 rounded-[9px] bg-secondary p-[3px]"
        >
          {filters.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={filter === option.value}
              // The segmented control's own look, from its `data-pressed` styles.
              {...(filter === option.value ? { "data-pressed": "" } : {})}
              onClick={() => {
                setFilter(option.value);
                setListOpen(true);
              }}
              className="h-[22px] rounded-[7px] px-[11px] text-[12px] font-medium whitespace-nowrap text-muted-foreground outline-none transition-[background-color,color] duration-(--dur-1) hover:text-foreground data-pressed:bg-popover data-pressed:text-foreground data-pressed:shadow-raised"
            >
              {option.label}
            </button>
          ))}
        </div>
        <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          <Switch
            checked={tree}
            onCheckedChange={(next) => {
              setTree(next);
              setListOpen(true);
            }}
          />
          Subagents
        </label>
      </div>
      {indexing && query && (
        <p className="border-t border-border px-3 py-1.5 text-xs text-subtle-foreground">
          {indexing}
        </p>
      )}
      {showList && (
        <Results
          hits={state.hits}
          active={active}
          threadId={nav.threadId}
          more={state.more}
          capped={state.capped}
          failed={state.failed}
          loading={state.loading}
          onOpen={open}
          onMore={() => void search.more()}
        />
      )}
    </div>
  );
}

function Results(props: {
  hits: readonly SearchHit[];
  active: number;
  threadId: string;
  more: boolean;
  capped: boolean;
  failed: boolean;
  loading: boolean;
  onOpen(hit: SearchHit, index: number): void;
  onMore(): void;
}) {
  const { hits } = props;
  return (
    // The scroller VirtualRows finds by its computed overflow.
    <div className="border-t border-border p-1" style={{ maxHeight: 320, overflowY: "auto" }}>
      {hits.length === 0 && !props.failed && (
        <p className="px-2.5 py-2 text-ui text-muted-foreground">
          {props.more
            ? "Nothing yet in the history read so far."
            : "Nothing in this thread matches."}
        </p>
      )}
      <div role="listbox" aria-label="Results">
        <LongRows
          virtualAbove={20}
          items={hits}
          rowKey={(hit) => `${hit.threadId}:${hit.itemId}`}
          estimate={52}
          render={(hit, index) => (
            <HitRow
              hit={hit}
              active={index === props.active}
              other={hit.threadId !== props.threadId}
              onOpen={() => props.onOpen(hit, index)}
            />
          )}
        />
      </div>
      {props.failed && (
        <p role="alert" className="px-2.5 py-2 text-xs text-status-failed">
          Search failed. Try again.
        </p>
      )}
      {props.capped ? (
        <p className="px-2.5 py-2 text-xs text-subtle-foreground">
          Showing the first 500 results. Add words or a filter to narrow them.
        </p>
      ) : (
        props.more && (
          <button
            type="button"
            disabled={props.loading}
            onClick={props.onMore}
            className="w-full rounded-md px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {props.loading
              ? "Searching…"
              : hits.length
                ? "Show more results"
                : "Search further back"}
          </button>
        )
      )}
    </div>
  );
}

function HitRow(props: { hit: SearchHit; active: boolean; other: boolean; onOpen(): void }) {
  const { hit } = props;
  const runs = snippetRuns(hit.snippet);
  return (
    // Options take the pointer; the keyboard stays in the search field (Enter, arrows).
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events
    <div
      role="option"
      aria-selected={props.active}
      tabIndex={-1}
      onClick={props.onOpen}
      className={cn(
        "flex w-full min-w-0 cursor-pointer flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-left hover:bg-accent",
        props.active && "bg-accent",
      )}
    >
      <span className="flex items-center gap-2 text-xs text-subtle-foreground">
        <span className="font-mono tabular-nums">
          {hit.turnOrdinal === null ? "Turn unknown" : `Turn ${hit.turnOrdinal}`}
        </span>
        {props.other && <span>· Subagent</span>}
      </span>
      <span className="line-clamp-2 text-ui text-muted-foreground">
        {runs.map((run, index) =>
          run.match ? (
            <mark
              // Runs are positional slices of one snippet; their order never changes.
              // oxlint-disable-next-line react/no-array-index-key
              key={index}
              className="rounded-[2px] bg-[color-mix(in_oklab,var(--ring)_38%,transparent)] text-foreground"
            >
              {run.text}
            </mark>
          ) : (
            // oxlint-disable-next-line react/no-array-index-key
            <span key={index}>{run.text}</span>
          ),
        )}
      </span>
    </div>
  );
}
