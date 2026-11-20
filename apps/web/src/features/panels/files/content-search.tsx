import { XIcon } from "@ace/icons";
import type { FileSearchFile, FileSearchLine } from "@ace/protocol";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
  type RefObject,
} from "react";
import { VirtualList } from "@/components/virtual-rows.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import type { ContentQuery } from "./content-search-source.ts";
import { FileRow, LineRow, plural } from "./content-search-rows.tsx";
import {
  hitKey,
  lineHit,
  type ContentSearchState,
  type ContentSearchStore,
  type SearchHit,
} from "./content-search-store.ts";

/** Past this many rows, only those near the viewport mount. */
const virtualAbove = 200;

type Row =
  | { kind: "file"; key: string; file: FileSearchFile; open: boolean }
  | { kind: "line"; key: string; path: string; line: FileSearchLine };

const count = (value: number) => value.toLocaleString();

/** "12 results in 3 files", or what the search is doing instead. */
function statusLine(state: ContentSearchState): string | undefined {
  if (!state.query.pattern) return undefined;
  if (state.status === "searching" && !state.matches) return "Searching…";
  if (state.status === "done" && !state.matches) return "No results.";
  if (state.status === "failed") return state.error?.message ?? "The search failed.";
  const matches = plural(state.matches, "result", "results");
  return `${matches} in ${plural(state.files.length, "file", "files")}`;
}

/** ↑ and ↓ walk the result rows that are mounted. */
function onListKeys(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-search-row]")];
  const at = buttons.findIndex((button) => button === document.activeElement);
  const next = buttons[at + (event.key === "ArrowDown" ? 1 : -1)];
  if (!next) return;
  event.preventDefault();
  next.focus();
}

/** A text toggle inside the query field: Aa, ab, .* */
function Toggle(props: { label: string; glyph: string; pressed: boolean; onPress(): void }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.pressed}
      onClick={props.onPress}
      className={cn(
        "grid h-6 min-w-6 shrink-0 place-items-center rounded-sm px-1 font-mono text-xs text-subtle-foreground outline-none hover:bg-accent hover:text-foreground focus-ring",
        props.pressed && "bg-active text-foreground",
      )}
    >
      {props.glyph}
    </button>
  );
}

function FilterField(props: { label: string; value: string; onChange(value: string): void }) {
  return (
    <input
      type="text"
      aria-label={props.label}
      placeholder={props.label}
      value={props.value}
      spellCheck={false}
      autoComplete="off"
      onChange={(event) => props.onChange(event.target.value)}
      className="h-8 w-full min-w-0 rounded-md bg-foreground/5 px-2.5 text-ui text-foreground shadow-[inset_0_0_0_1px_var(--border)] outline-none placeholder:text-subtle-foreground focus:shadow-[inset_0_0_0_1px_var(--ring)]"
    />
  );
}

/**
 * Search across the checkout's file contents, as an editor's Search view: one field with case,
 * whole-word and regex toggles, optional include and exclude globs, then the matches grouped
 * by file. Enter or a click on a match opens the file with the match selected; the list, its
 * folds and its scroll stay as they were. F4 and ⇧F4 open the next and previous hit from
 * anywhere in the panel.
 */
export function ContentSearch({
  ref,
  ...props
}: {
  /** The query field, for ⌘⇧F to focus. */
  ref?: Ref<HTMLInputElement> | undefined;
  store: ContentSearchStore;
  state: ContentSearchState;
  /** Open a hit: at `line` (1-based) and `column`, the match `length` long. */
  onOpen(path: string, line: number, column: number, keep: boolean, length?: number): void;
  /** Esc in an empty field: back to the file tree. */
  onClose(): void;
}) {
  const { store, state } = props;
  const query = state.query;
  const [filters, setFilters] = useState(() => Boolean(query.include || query.exclude));
  const update = (patch: Partial<ContentQuery>) => store.update(patch);
  const rows: Row[] = [];
  let widest = 0;
  for (const file of state.files) {
    const open = !state.closed.has(file.path);
    rows.push({ kind: "file", key: `f:${file.path}`, file, open });
    for (const line of file.lines) widest = Math.max(widest, line.line);
    if (open)
      for (const line of file.lines)
        rows.push({ kind: "line", key: `l:${file.path}:${line.line}`, path: file.path, line });
  }
  const digits = Math.max(2, String(widest).length);
  const open = (hit: SearchHit, keep: boolean) => {
    store.pick(hit);
    props.onOpen(hit.path, hit.line, hit.column, keep, hit.length);
  };
  const root = useRef<HTMLDivElement>(null);
  useStepKeys(store, props.onOpen, root);
  // The list mounts again after a pick (the tab it sits in turns into the file): it comes back
  // scrolled where it was.
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (list.current) list.current.scrollTop = store.scrolled;
  }, [store]);
  const status = statusLine(state);
  return (
    <div ref={root} className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-col gap-1.5 px-2 pb-1.5">
        <label className="relative flex h-8 min-w-0 items-center rounded-md bg-foreground/5 shadow-[inset_0_0_0_1px_var(--border)] transition-shadow duration-(--motion-fast) focus-within:shadow-[inset_0_0_0_1px_var(--ring)]">
          <input
            ref={ref}
            type="search"
            aria-label="Search file contents"
            placeholder="Search in files…"
            value={query.pattern}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => update({ pattern: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                store.run();
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                if (query.pattern) update({ pattern: "" });
                else props.onClose();
              }
            }}
            className="h-full min-w-0 flex-1 bg-transparent pr-1 pl-2.5 text-ui text-foreground outline-none placeholder:text-subtle-foreground [&::-webkit-search-cancel-button]:hidden"
          />
          {state.status === "searching" && <Spinner className="mr-1" />}
          {query.pattern && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => update({ pattern: "" })}
              className="grid size-6 shrink-0 place-items-center rounded-sm text-subtle-foreground outline-none hover:bg-accent hover:text-foreground focus-ring"
            >
              <XIcon aria-hidden size={12} />
            </button>
          )}
          <span className="mr-1 flex items-center gap-0.5">
            <Toggle
              label="Match case"
              glyph="Aa"
              pressed={query.matchCase}
              onPress={() => store.update({ matchCase: !query.matchCase }, true)}
            />
            <Toggle
              label="Match whole word"
              glyph="ab"
              pressed={query.wholeWord}
              onPress={() => store.update({ wholeWord: !query.wholeWord }, true)}
            />
            <Toggle
              label="Use regular expression"
              glyph=".*"
              pressed={query.regex}
              onPress={() => store.update({ regex: !query.regex }, true)}
            />
          </span>
        </label>
        {filters ? (
          <>
            <FilterField
              label="Files to include"
              value={query.include}
              onChange={(include) => update({ include })}
            />
            <FilterField
              label="Files to exclude"
              value={query.exclude}
              onChange={(exclude) => update({ exclude })}
            />
          </>
        ) : null}
        <div className="flex min-h-6 items-center gap-2 text-xs leading-4 text-muted-foreground">
          <span role="status" className="min-w-0 flex-1 truncate">
            {status}
          </span>
          {state.status === "failed" && (
            <Button size="sm" variant="ghost" onClick={() => store.run()}>
              Try again
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={filters}
            onClick={() => {
              if (filters) update({ include: "", exclude: "" });
              setFilters(!filters);
            }}
          >
            {filters ? "Hide filters" : "Filters"}
          </Button>
        </div>
        {state.summary?.truncated && (
          <p className="text-xs leading-4 text-muted-foreground">
            Showing the first {count(state.matches)} results. Narrow the search to see the rest.
          </p>
        )}
      </div>
      <div
        ref={list}
        role="presentation"
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
        onKeyDown={onListKeys}
        onScroll={(event) => store.keepScroll(event.currentTarget.scrollTop)}
      >
        <VirtualList
          items={rows}
          virtualAbove={virtualAbove}
          label="Search results"
          rowKey={(row) => row.key}
          estimate={28}
          render={(row) =>
            row.kind === "file" ? (
              <FileRow
                file={row.file}
                open={row.open}
                onToggle={() => store.toggle(row.file.path)}
              />
            ) : (
              <LineRow
                path={row.path}
                line={row.line}
                digits={digits}
                current={state.cursor === hitKey(row.path, row.line.line)}
                onOpen={(keep) => open(lineHit(row.path, row.line), keep)}
              />
            )
          }
        />
      </div>
    </div>
  );
}

type OpenHit = Parameters<typeof ContentSearch>[0]["onOpen"];

/**
 * F4 and ⇧F4 open the next and previous hit as a glance, while focus is in the panel the search
 * sits in (or nowhere, as after the list mounted again). Several mounted views of one search
 * step once: the first to see the key takes it. The editor binds these in its keymap scope.
 */
function useStepKeys(
  store: ContentSearchStore,
  onOpen: OpenHit,
  root: RefObject<HTMLElement | null>,
) {
  const latest = useRef(onOpen);
  useEffect(() => {
    latest.current = onOpen;
  });
  useEffect(() => {
    const doc = root.current?.ownerDocument;
    if (!doc) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "F4" || event.defaultPrevented) return;
      if (event.altKey || event.metaKey || event.ctrlKey) return;
      const panel = root.current?.closest("[data-panel]");
      const active = doc.activeElement;
      if (!panel || (active && active !== doc.body && !panel.contains(active))) return;
      const hit = store.step(event.shiftKey ? -1 : 1);
      if (!hit) return;
      event.preventDefault();
      latest.current(hit.path, hit.line, hit.column, false, hit.length);
    };
    doc.addEventListener("keydown", onKey);
    return () => doc.removeEventListener("keydown", onKey);
  }, [store, root]);
}
