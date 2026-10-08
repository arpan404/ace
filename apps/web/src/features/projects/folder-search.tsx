import {
  ArrowElbowDownLeftIcon,
  DesktopTowerIcon,
  FolderOpenIcon,
  FolderSimpleIcon,
  FolderSimpleStarIcon,
  GitBranchIcon,
  HouseSimpleIcon,
  MagnifyingGlassIcon,
} from "@phosphor-icons/react";
import { crumbs, displayPath, pathInput, upInput } from "@ace/ui-core";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { LongRows, type VirtualRowsHandle } from "@/components/virtual-rows.tsx";
import { cn } from "@/lib/cn.ts";
import { applePlatform } from "@/lib/keymap.ts";
import { AllowFolder } from "./allow-folder.tsx";
import { Badge, Notice, RefusedNotice, offlineIcon } from "./folder-notices.tsx";
import type { FolderRow, FolderSearch, SearchMode } from "./use-folder-search.ts";

/** Rows of a folder this long and longer mount only near the viewport. */
const virtualAbove = 120;
const mod = (event: KeyboardEvent) => (applePlatform ? event.metaKey : event.ctrlKey);

/**
 * The search box over a daemon's folders, as a combobox: letters search, `/`, `~` and `./`
 * browse a path. ↑/↓ (and Ctrl-N/P) move, Tab completes a path (or goes into the highlighted
 * folder), Backspace on an empty segment and ⌘↑ go up, Esc clears. In `open` mode Enter opens
 * the highlighted folder and ⌘Enter opens it in a new thread; in `location` mode Enter goes into
 * it and ⌘Enter is left to the form.
 */
export function FolderSearchBox(props: {
  label: string;
  listLabel: string;
  placeholder: string;
  search: FolderSearch;
  text: string;
  onText(text: string): void;
  mode: SearchMode;
  /** Badges name each row's machine when there is more than one. */
  several: boolean;
  onChoose?(row: FolderRow, how: { newThread: boolean }): void;
  onHighlight?(row: FolderRow | undefined): void;
  autoFocus?: boolean;
  disabled?: boolean;
  trailing?: ReactNode;
  listClassName?: string;
}) {
  const { search, text, onText, mode } = props;
  const { query, rows, sections, home } = search;
  const listId = useId();
  const [active, setActive] = useState(0);
  const current = Math.min(active, Math.max(0, rows.length - 1));
  // Rows still cached from before the machine went away, or from a folder now refused, stay
  // out of reach.
  const blocked = search.offline || search.failure !== undefined;
  const pointed = blocked ? undefined : rows[current];
  // A row still showing from the previous query is never chosen for this one.
  const highlighted = pointed?.stale ? undefined : pointed;
  const virtual = useRef<VirtualRowsHandle>(null);
  const roots = home?.roots ?? [];
  const optionId = (index: number) => `${listId}-${index}`;
  // What the box holds now, for replies that arrive later: the text and the machine it's for.
  const latest = useRef({ text, machine: search.machineId });
  useEffect(() => {
    latest.current = { text, machine: search.machineId };
  }, [text, search.machineId]);
  // One completion at a time; a newer Tab, another machine or closing abandons the last one.
  const completing = useRef<AbortController | undefined>(undefined);
  const { machineId } = search;
  useEffect(() => {
    // A completion begun for one machine never lands on another, nor after closing.
    if (!machineId) return;
    return () => completing.current?.abort();
  }, [machineId]);

  const { onHighlight } = props;
  useEffect(() => onHighlight?.(highlighted), [onHighlight, highlighted]);
  // Keep the highlighted folder in view; one in a long folder may need mounting first.
  useEffect(() => {
    const element = document.getElementById(optionId(current));
    if (element) element.scrollIntoView?.({ block: "nearest" });
    else {
      const children = sections.find((section) => section.id === "children");
      const offset = children ? rows.indexOf(children.rows[0] as FolderRow) : -1;
      if (offset >= 0 && current >= offset) virtual.current?.scrollToIndex(current - offset);
    }
  });

  const type = (next: string) => {
    onText(next);
    setActive(0);
  };
  const browse = (path: string) => type(pathInput(path, home?.path));
  const choose = (row: FolderRow | undefined, newThread: boolean) => {
    if (!row) return;
    if (mode === "location") browse(row.path);
    else props.onChoose?.(row, { newThread });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const key = event.key;
    const caretAtEnd =
      event.currentTarget.selectionStart === text.length &&
      event.currentTarget.selectionEnd === text.length;
    const count = rows.length;
    if (key === "ArrowDown" || (event.ctrlKey && key === "n"))
      setActive(count ? (current + 1) % count : 0);
    else if (key === "ArrowUp" && mod(event)) {
      const up = query.kind === "path" ? upInput(query, home?.path) : undefined;
      if (up === undefined) return;
      type(up);
    } else if (key === "ArrowUp" || (event.ctrlKey && key === "p"))
      setActive(count ? (current - 1 + count) % count : 0);
    else if (key === "Enter") {
      if (mode === "location" && mod(event)) return;
      choose(highlighted, mod(event));
    } else if (key === "Tab" && !event.shiftKey && !event.altKey && !mod(event)) {
      if (query.kind === "path") {
        // The daemon completes. Its reply applies only to the same text on the same machine.
        const typed = { text, machine: search.machineId };
        const fallback =
          highlighted && !highlighted.self && query.segment ? highlighted : undefined;
        completing.current?.abort();
        const controller = new AbortController();
        completing.current = controller;
        void search.complete(controller.signal).then(
          (completed) => {
            const now = latest.current;
            if (controller.signal.aborted) return;
            if (now.text !== typed.text || now.machine !== typed.machine) return;
            if (completed) type(completed);
            else if (fallback) browse(fallback.path);
          },
          () => {},
        );
      } else if (highlighted && text) browse(highlighted.path);
      else return;
    } else if (key === "Backspace" && query.kind === "path" && !query.segment && caretAtEnd) {
      const up = upInput(query, home?.path, roots);
      if (up === undefined) return;
      type(up);
    } else if (key === "Escape" && text) {
      // Clears first; a second Esc closes the dialog.
      event.stopPropagation();
      type("");
    } else return;
    event.preventDefault();
  };

  let state: ReactNode = null;
  if (search.offline)
    state = (
      <Notice icon={offlineIcon}>
        That machine isn't connected. Folders come back once it is.
      </Notice>
    );
  else if (search.failure)
    state = (
      <RefusedNotice
        problem={search.failure}
        roots={roots}
        home={home?.path}
        onGo={browse}
        onRetry={search.retry}
        allow={
          search.failure.canAllow && query.kind === "path" ? (
            <AllowFolder client={search.client} path={query.directory} onAllowed={search.retry} />
          ) : undefined
        }
      />
    );
  else if (!rows.length && search.loading)
    state = <ListSkeleton label="folders" shape="row" rows={6} />;
  else if (!rows.length)
    state = (
      <Notice icon={FolderSimpleIcon}>
        {query.kind === "path"
          ? query.segment
            ? `No folders in ${displayPath(query.directory, home?.path)} start with “${query.segment}”.`
            : `${displayPath(query.directory, home?.path)} has no folders inside.`
          : text
            ? `No folders match “${text}”. Type a path, like ~/ or /, to browse.`
            : "No folders here yet."}
      </Notice>
    );

  // Each section's first option index, so ids run on across sections.
  const starts = sections.map((_, at) =>
    sections.slice(0, at).reduce((sum, section) => sum + section.rows.length, 0),
  );
  return (
    <div className="grid min-w-0 gap-2">
      <div className="flex h-9 items-center gap-2 rounded-md bg-input px-2.5 focus-within:shadow-[0_0_0_2px_color-mix(in_oklab,var(--ring)_45%,transparent)]">
        <Icon
          icon={query.kind === "path" ? FolderOpenIcon : MagnifyingGlassIcon}
          size={16}
          className="text-muted-foreground"
        />
        <input
          role="combobox"
          aria-label={props.label}
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={pointed ? optionId(current) : undefined}
          aria-describedby={`${listId}-path`}
          placeholder={props.placeholder}
          value={text}
          disabled={props.disabled}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- The dialog opens to its search.
          autoFocus={props.autoFocus}
          onChange={(event) => type(event.target.value)}
          onKeyDown={onKeyDown}
          className={cn(
            "h-full min-w-0 flex-1 bg-transparent text-ui text-foreground focus:outline-none placeholder:text-subtle-foreground",
            query.kind === "path" && "font-mono text-sm",
          )}
        />
        {search.loading && rows.length > 0 && <Spinner label="Loading folders" />}
        {props.trailing}
      </div>
      {query.kind === "path" && (
        <nav aria-label="Folder path" className="min-w-0">
          <ol className="flex min-w-0 items-center gap-0.5 overflow-hidden text-sm text-muted-foreground">
            {crumbs(query.directory, home?.path).map((crumb, at, all) => (
              <li key={crumb.path} className="flex min-w-0 items-center gap-0.5">
                {at > 0 && <span aria-hidden>/</span>}
                <button
                  type="button"
                  aria-current={at === all.length - 1 ? "location" : undefined}
                  onClick={() => browse(crumb.path)}
                  className="inline-flex h-[22px] min-w-0 items-center gap-1 rounded-sm px-1.5 focus-ring transition-colors duration-(--dur-1) hover:bg-accent hover:text-foreground focus-visible:bg-accent aria-[current]:text-foreground"
                >
                  {crumb.home && <Icon icon={HouseSimpleIcon} size={13} />}
                  <span className="truncate">{crumb.label}</span>
                </button>
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div
        className={cn(
          "h-72 overflow-y-auto overscroll-contain rounded-md bg-secondary p-1",
          props.listClassName,
        )}
      >
        {state}
        <div id={listId} role="listbox" aria-label={props.listLabel} hidden={state !== null}>
          {sections.map((section, place) => {
            const first = starts[place] ?? 0;
            const render = (row: FolderRow, at: number) => (
              <FolderOption
                id={optionId(first + at)}
                row={row}
                active={first + at === current}
                several={props.several && (section.id === "recent" || section.id === "projects")}
                home={home?.path}
                onPoint={() => setActive(first + at)}
                onPick={() => choose(row, false)}
              />
            );
            return (
              <div key={section.id} role="group" aria-labelledby={`${listId}-${section.id}`}>
                <div
                  id={`${listId}-${section.id}`}
                  className="px-2 pt-2 pb-1 text-xs font-medium text-subtle-foreground"
                >
                  {section.label}
                </div>
                {section.id === "children" ? (
                  <LongRows
                    items={section.rows}
                    rowKey={(row) => row.key}
                    estimate={30}
                    virtualAbove={virtualAbove}
                    handle={virtual}
                    render={render}
                  />
                ) : (
                  section.rows.map((row, at) => <div key={row.key}>{render(row, at)}</div>)
                )}
              </div>
            );
          })}
        </div>
      </div>
      {state === null && (search.restFailed || search.capped) && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          {search.restFailed
            ? "Couldn't read the rest of this folder. The folders above are what was read."
            : "Showing the first 5,000 folders here. Type more of a name to narrow them."}
          {search.restFailed && (
            <Button size="sm" variant="ghost" onClick={search.retry}>
              Try again
            </Button>
          )}
        </p>
      )}
      <div className="flex min-h-5 min-w-0 flex-wrap items-center gap-3 text-xs text-subtle-foreground">
        <span id={`${listId}-path`} className="min-w-0 flex-1 truncate font-mono text-xs">
          {highlighted
            ? `${displayPath(highlighted.path, home?.path)}${props.several ? ` · ${highlighted.machine.name}` : ""}`
            : ""}
        </span>
        <KeyHints mode={mode} />
      </div>
    </div>
  );
}

function KeyHints(props: { mode: SearchMode }) {
  return (
    <span aria-hidden className="hidden shrink-0 items-center gap-2.5 sm:flex">
      <span className="inline-flex items-center gap-1">
        <Kbd>↵</Kbd>
        {props.mode === "open" ? "open" : "go in"}
      </span>
      <span className="inline-flex items-center gap-1">
        <Kbd>tab</Kbd>
        complete
      </span>
    </span>
  );
}

/** The name with the typed letters in bold, as runs of plain and matched text. */
function Name(props: { name: string; positions: readonly number[] }) {
  if (!props.positions.length) return props.name;
  const hits = new Set(props.positions);
  const runs: { start: number; text: string; hit: boolean }[] = [];
  [...props.name].forEach((char, at) => {
    const last = runs.at(-1);
    if (last && last.hit === hits.has(at)) last.text += char;
    else runs.push({ start: at, text: char, hit: hits.has(at) });
  });
  return runs.map((run) =>
    run.hit ? (
      <b key={run.start} className="font-semibold text-foreground">
        {run.text}
      </b>
    ) : (
      <span key={run.start}>{run.text}</span>
    ),
  );
}

function FolderOption(props: {
  id: string;
  row: FolderRow;
  active: boolean;
  several: boolean;
  home: string | undefined;
  onPoint(): void;
  onPick(): void;
}) {
  const { row } = props;
  return (
    <div
      id={props.id}
      role="option"
      aria-selected={props.active}
      aria-disabled={row.stale ? true : undefined}
      tabIndex={-1}
      onPointerMove={props.active ? undefined : props.onPoint}
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.onPick}
      className={cn(
        "flex h-[30px] cursor-default items-center gap-2 rounded-sm px-2 text-ui text-foreground select-none",
        props.active && "bg-accent",
        row.stale && "opacity-60",
      )}
    >
      <Icon
        icon={row.self ? FolderOpenIcon : row.project ? FolderSimpleStarIcon : FolderSimpleIcon}
        size={14}
        className="text-muted-foreground"
      />
      <span className="max-w-[60%] shrink-0 truncate text-foreground">
        <Name name={row.name} positions={row.positions} />
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-subtle-foreground">
        {props.active ? displayPath(row.path, props.home) : ""}
      </span>
      {row.self && <Badge icon={ArrowElbowDownLeftIcon}>Open</Badge>}
      {row.project && !row.self && <Badge>Project</Badge>}
      {row.git && <Badge icon={GitBranchIcon}>Git</Badge>}
      {props.several && <Badge icon={DesktopTowerIcon}>{row.machine.name}</Badge>}
    </div>
  );
}
