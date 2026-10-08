import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useConnectionState } from "@ace/client-react";
import { fuzzyPositions, pathParts } from "@ace/ui-core";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Icon } from "@/components/icon.tsx";
import { CommandDialog } from "@/components/ui/command.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import { useScopeWorkspace, useWorkspaceActions } from "@/lib/workspace/index.ts";
import { fileIcon } from "./file-icon.ts";
import { useRecentFiles } from "./files-state.ts";
import { openFile } from "./open-file.ts";
import { useCheckoutSearch, useEditedPaths } from "./use-checkout.ts";

interface Row {
  path: string;
  group: string;
}

/** "src/app.ts:42" → the file to find and the line to show. */
export function parseQuickOpen(text: string): { query: string; line: number | undefined } {
  const match = /^(.*?):(\d+)$/.exec(text.trim());
  if (!match?.[1]) return { query: text.trim(), line: undefined };
  return { query: match[1], line: Number(match[2]) || undefined };
}

function Name(props: { path: string; query: string }) {
  const { name, folder } = pathParts(props.path);
  const positions = props.query ? (fuzzyPositions(props.query, props.path) ?? []) : [];
  const start = props.path.length - name.length;
  const hits = new Set(positions.filter((at) => at >= start).map((at) => at - start));
  const parts: ReactNode[] = [];
  for (let index = 0; index < name.length; index++)
    parts.push(
      hits.has(index) ? (
        <b key={index} className="font-semibold text-foreground">
          {name[index]}
        </b>
      ) : (
        name[index]
      ),
    );
  return (
    <>
      <span className="shrink-0 truncate text-foreground">{parts}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-subtle-foreground">
        {folder || "Project root"}
      </span>
    </>
  );
}

/**
 * ⌘P: find a file in the thread's checkout by a few letters of its path, or reopen a recent one.
 * Arrows move, Enter opens it in a tab that stays, Escape returns focus where it was.
 * `path:line` opens at that line.
 */
export function QuickOpenDialog(props: { threadId: string; onClose(): void }) {
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const online = useConnectionState() === "ready";
  const { query, line } = parseQuickOpen(text);
  const search = useCheckoutSearch(props.threadId, query);
  const recent = useRecentFiles(props.threadId);
  const edited = useEditedPaths(props.threadId);
  const workspace = useScopeWorkspace(props.threadId);
  const actions = useWorkspaceActions(props.threadId);
  const listId = useId();
  const rows = useMemo<Row[]>(() => {
    if (query)
      return (search.data ?? [])
        .filter((path) => !path.endsWith("/"))
        .map((path) => ({ path, group: "Files" }));
    const opened = recent.slice(0, 8).map((path) => ({ path, group: "Opened recently" }));
    const seen = new Set(recent.slice(0, 8));
    const touched = edited
      .filter((path) => !seen.has(path))
      .slice(0, 8)
      .map((path) => ({ path, group: "Edited in this thread" }));
    return [...opened, ...touched];
  }, [query, search.data, recent, edited]);
  const current = Math.min(active, Math.max(0, rows.length - 1));

  const choose = (row: Row | undefined) => {
    if (!row) return;
    props.onClose();
    openFile(workspace, actions, row.path, { keep: true, line });
  };
  const optionId = (index: number) => `${listId}-${index}`;
  // Enter pressed before the results arrived opens the best one once they do.
  const [waiting, setWaiting] = useState(false);
  const settled = query === search.settledQuery && !search.pending;
  const first = rows[0];
  // Keep the highlighted file in view as the arrows move through a long list.
  useEffect(() => {
    document.getElementById(optionId(current))?.scrollIntoView?.({ block: "nearest" });
  });
  useEffect(() => {
    if (waiting && settled && first) choose(first);
  });

  let status: ReactNode = null;
  if (query && !online) status = "ace is offline. Search works again once it reconnects.";
  else if (query && search.error) status = `Couldn't search the checkout. ${search.error.message}`;
  else if (query && search.pending && !rows.length) status = "Searching files…";
  else if (query && !rows.length) status = `No files match “${query}”.`;
  else if (!query && !rows.length)
    status = "No recent files yet. Type a few letters of a file's name.";

  return (
    <CommandDialog open onOpenChange={(open) => !open && props.onClose()} title="Open a file">
      <div className="flex h-[52px] shrink-0 items-center gap-2.5 border-b px-4">
        <MagnifyingGlassIcon aria-hidden size={18} className="shrink-0 text-muted-foreground" />
        <input
          role="combobox"
          aria-label="Search files"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={rows.length ? optionId(current) : undefined}
          placeholder="Search files by name or path"
          value={text}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            setText(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") setActive((current + 1) % Math.max(1, rows.length));
            else if (event.key === "ArrowUp")
              setActive((current - 1 + rows.length) % Math.max(1, rows.length));
            else if (event.key === "Enter") {
              if (query && (search.pending || query !== search.settledQuery)) setWaiting(true);
              else choose(rows[current]);
            } else return;
            event.preventDefault();
          }}
          className="h-full min-w-0 flex-1 bg-transparent text-[16px] text-foreground outline-none placeholder:text-subtle-foreground"
        />
        {query && search.pending && <Spinner label="Searching" />}
        <Kbd>esc</Kbd>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <ul id={listId} role="listbox" aria-label="Files" className="flex flex-col">
          {rows.map((row, index) => (
            <li key={`${row.group}:${row.path}`} role="presentation">
              {(index === 0 || rows[index - 1]?.group !== row.group) && (
                <p
                  role="presentation"
                  className="px-2.5 pt-2 pb-1 text-xs font-medium text-subtle-foreground"
                >
                  {row.group}
                </p>
              )}
              <div
                id={optionId(index)}
                role="option"
                aria-selected={index === current}
                tabIndex={-1}
                onPointerMove={() => setActive(index)}
                onClick={() => choose(row)}
                className={cn(
                  "flex h-9 cursor-default items-center gap-[9px] rounded-md px-2.5 text-ui select-none",
                  index === current && "bg-accent",
                )}
              >
                <Icon icon={fileIcon(row.path)} size={16} className="text-muted-foreground" />
                <Name path={row.path} query={query} />
              </div>
            </li>
          ))}
        </ul>
        {status && (
          <p role="status" className="px-2.5 py-6 text-center text-ui text-subtle-foreground">
            {status}
          </p>
        )}
      </div>
      <div className="flex shrink-0 gap-3.5 border-t px-3.5 py-2 text-xs text-subtle-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          navigate
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Kbd>↵</Kbd>
          open
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Kbd>:12</Kbd>
          go to a line
        </span>
      </div>
    </CommandDialog>
  );
}
