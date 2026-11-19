import { CaretRightIcon, XIcon } from "@ace/icons";
import type { FileSearchFile, FileSearchLine } from "@ace/protocol";
import { useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { VirtualList } from "@/components/virtual-rows.tsx";
import { Icon } from "@/components/icon.tsx";
import { fileIcon } from "@/components/file-icon.ts";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import type { ContentQuery } from "./content-search-source.ts";
import {
  matchCount,
  type ContentSearchState,
  type ContentSearchStore,
} from "./content-search-store.ts";

/** Past this many rows, only those near the viewport mount. */
const virtualAbove = 200;
/** Characters a preview keeps before its first match, so a match far into a line shows. */
const lead = 24;

type Row =
  | { kind: "file"; key: string; file: FileSearchFile; open: boolean }
  | { kind: "line"; key: string; path: string; line: FileSearchLine };

const count = (value: number) => value.toLocaleString();
const plural = (value: number, one: string, many: string) =>
  `${count(value)} ${value === 1 ? one : many}`;

/** "12 results in 3 files", or what the search is doing instead. */
function statusLine(state: ContentSearchState): string | undefined {
  if (!state.query.pattern) return undefined;
  if (state.status === "searching" && !state.matches) return "Searching…";
  if (state.status === "done" && !state.matches) return "No results.";
  if (state.status === "failed") return state.error?.message ?? "The search failed.";
  const matches = plural(state.matches, "result", "results");
  return `${matches} in ${plural(state.files.length, "file", "files")}`;
}

/** A preview line with its matches marked, cut in front when the first match is far in. */
function Preview(props: { line: FileSearchLine }) {
  const { preview, ranges } = props.line;
  const first = ranges[0]?.[0] ?? 0;
  const from = first > lead ? first - lead : 0;
  const parts: ReactNode[] = from ? ["…"] : [];
  let at = from;
  for (const [index, [start, end]] of ranges.entries()) {
    if (end <= at) continue;
    const begin = Math.max(start, at);
    if (begin > at) parts.push(preview.slice(at, begin));
    parts.push(
      <mark key={index} className="rounded-xs bg-foreground/18 text-foreground">
        {preview.slice(begin, end)}
      </mark>,
    );
    at = end;
  }
  if (at < preview.length) parts.push(preview.slice(at));
  return <span className="min-w-0 truncate whitespace-pre">{parts}</span>;
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
 * by file. Enter or a click on a match opens the file at its line and column.
 */
export function ContentSearch({
  ref,
  ...props
}: {
  /** The query field, for ⌘⇧F to focus. */
  ref?: Ref<HTMLInputElement> | undefined;
  store: ContentSearchStore;
  state: ContentSearchState;
  onOpen(path: string, line: number, column: number, keep: boolean): void;
  /** Esc in an empty field: back to the file tree. */
  onClose(): void;
}) {
  const { store, state } = props;
  const query = state.query;
  const [filters, setFilters] = useState(() => Boolean(query.include || query.exclude));
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const update = (patch: Partial<ContentQuery>) => store.update(patch);
  const rows: Row[] = [];
  for (const file of state.files) {
    const open = !closed.has(file.path);
    rows.push({ kind: "file", key: `f:${file.path}`, file, open });
    if (open)
      for (const line of file.lines)
        rows.push({ kind: "line", key: `l:${file.path}:${line.line}`, path: file.path, line });
  }
  const toggleFile = (path: string) =>
    setClosed((previous) => {
      const next = new Set(previous);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  const status = statusLine(state);
  return (
    <div className="flex h-full min-h-0 flex-col">
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
        role="presentation"
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
        onKeyDown={onListKeys}
      >
        <VirtualList
          items={rows}
          virtualAbove={virtualAbove}
          label="Search results"
          rowKey={(row) => row.key}
          estimate={28}
          render={(row) =>
            row.kind === "file" ? (
              <FileRow row={row} onToggle={() => toggleFile(row.file.path)} />
            ) : (
              <button
                type="button"
                data-search-row
                aria-label={`${row.path} line ${row.line.line}: ${row.line.preview.trim()}`}
                onClick={(event) =>
                  props.onOpen(
                    row.path,
                    row.line.line,
                    row.line.column + (row.line.ranges[0]?.[0] ?? 0),
                    event.detail > 1,
                  )
                }
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  props.onOpen(
                    row.path,
                    row.line.line,
                    row.line.column + (row.line.ranges[0]?.[0] ?? 0),
                    true,
                  );
                }}
                className="flex h-7 w-full min-w-0 items-center gap-2 rounded-sm pr-2 pl-7 text-left font-mono text-xs text-muted-foreground outline-none select-none hover:bg-accent focus-visible:shadow-[inset_0_0_0_1.5px_var(--ring)]"
              >
                <span className="w-8 shrink-0 text-right text-subtle-foreground tabular-nums">
                  {row.line.line}
                </span>
                <Preview line={row.line} />
              </button>
            )
          }
        />
      </div>
    </div>
  );
}

function FileRow(props: { row: Extract<Row, { kind: "file" }>; onToggle(): void }) {
  const { file, open } = props.row;
  const matches = matchCount(file);
  const slash = file.path.lastIndexOf("/");
  const name = file.path.slice(slash + 1);
  const folder = slash > 0 ? file.path.slice(0, slash) : "";
  return (
    <button
      type="button"
      data-search-row
      aria-expanded={open}
      aria-label={`${file.path}, ${plural(matches, "result", "results")}`}
      onClick={props.onToggle}
      className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-sm pr-2 text-left text-ui outline-none select-none hover:bg-accent focus-visible:shadow-[inset_0_0_0_1.5px_var(--ring)]"
    >
      <span className="grid size-4 shrink-0 place-items-center">
        <CaretRightIcon
          aria-hidden
          size={10}
          className={cn(
            "text-subtle-foreground transition-transform duration-(--motion-fast)",
            open && "rotate-90",
          )}
        />
      </span>
      <Icon icon={fileIcon(file.path)} size={14} className="shrink-0 text-subtle-foreground" />
      <span className="min-w-0 truncate">
        <span className="text-foreground">{name}</span>
        {folder && <span className="ml-1.5 text-xs text-subtle-foreground">{folder}</span>}
      </span>
      <span className="ml-auto shrink-0 text-xs text-subtle-foreground tabular-nums">
        {count(matches)}
      </span>
    </button>
  );
}
