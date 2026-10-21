import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CaretDownIcon, CaretUpIcon } from "@phosphor-icons/react";
import type { ForgeCheckLog } from "@ace/protocol";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { LongRows, type VirtualRowsHandle } from "@/components/virtual-rows.tsx";
import { cn } from "@/lib/cn.ts";
import { nextMatch, searchLog } from "./pr-check-model.ts";

/** Past this many lines only the rows near the viewport mount. */
const windowAbove = 400;
const rowHeight = 18;

function highlight(line: string, query: string): ReactNode {
  const needle = query.trim().toLowerCase();
  if (!needle) return line;
  const at = line.toLowerCase().indexOf(needle);
  if (at < 0) return line;
  return (
    <>
      {line.slice(0, at)}
      <mark className="rounded-xs bg-active text-foreground">
        {line.slice(at, at + needle.length)}
      </mark>
      {line.slice(at + needle.length)}
    </>
  );
}

/** Scrolls `line` to the top of the log, mounted or not. */
function scrollToLine(
  scroller: HTMLDivElement | null,
  rows: VirtualRowsHandle | null,
  line: number,
) {
  const row = scroller?.querySelector<HTMLElement>(`[data-log-line="${line}"]`);
  if (scroller && row)
    scroller.scrollTop +=
      row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - rowHeight;
  else rows?.scrollToIndex(line);
}

/**
 * A job log: windowed, opening at `jump` (the failing step), errors in the failed colour, with
 * its own search (the browser's can't see rows that aren't mounted): Enter for the next match,
 * Shift+Enter for the previous.
 */
export function PrCheckLog(props: {
  log: ForgeCheckLog;
  name: string;
  /** Bumped with a line to bring it to the top: a step picked from the list. */
  jump?: { line: number; seq: number } | undefined;
}) {
  const { log } = props;
  const lines = useMemo(() => log.text.split("\n"), [log.text]);
  const errors = useMemo(() => new Set(log.errors), [log.errors]);
  const [query, setQuery] = useState("");
  const matches = useMemo(() => searchLog(lines, query), [lines, query]);
  const [current, setCurrent] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const rows = useRef<VirtualRowsHandle>(null);
  const focus = log.focus;
  // The log opens at the failing step, once: on the next frame, after a long log's window has
  // found its scroller.
  useEffect(() => {
    if (focus === null) return;
    const frame = requestAnimationFrame(() => scrollToLine(scroller.current, rows.current, focus));
    return () => cancelAnimationFrame(frame);
  }, [focus]);
  const jump = props.jump;
  useEffect(() => {
    if (jump) scrollToLine(scroller.current, rows.current, jump.line);
  }, [jump]);
  const go = (index: number) => {
    if (!matches.length) return;
    const wrapped = (index + matches.length) % matches.length;
    setCurrent(wrapped);
    const line = matches[wrapped];
    if (line !== undefined) scrollToLine(scroller.current, rows.current, line);
  };
  const onSearch = (value: string) => {
    setQuery(value);
    const found = searchLog(lines, value);
    const index = nextMatch(found, focus ?? 0);
    setCurrent(index);
    const line = found[index];
    if (line !== undefined) scrollToLine(scroller.current, rows.current, line);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    go(current + (event.shiftKey ? -1 : 1));
  };
  const selected = matches[current];
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <Input
          type="search"
          value={query}
          onChange={(event) => onSearch(event.target.value)}
          onKeyDown={onKeyDown}
          aria-label={`Search the log of ${props.name}`}
          placeholder="Search log"
          className="h-7 flex-1"
        />
        {query.trim() && (
          <span role="status" className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {matches.length ? `${current + 1} of ${matches.length}` : "No matches"}
          </span>
        )}
        <IconButton
          icon={CaretUpIcon}
          label="Previous match"
          keys="⇧↵"
          resolve={false}
          size="sm"
          disabled={!matches.length}
          onClick={() => go(current - 1)}
        />
        <IconButton
          icon={CaretDownIcon}
          label="Next match"
          keys="↵"
          resolve={false}
          size="sm"
          disabled={!matches.length}
          onClick={() => go(current + 1)}
        />
      </div>
      <div
        ref={scroller}
        role="log"
        aria-label={`Log of ${props.name}`}
        tabIndex={0}
        className="max-h-96 overflow-auto rounded-md border border-border bg-muted py-1 font-mono text-xs leading-[18px] focus-ring-inset"
      >
        {log.truncated && (
          <p className="px-2 pb-1 text-subtle-foreground">Earlier lines are on GitHub.</p>
        )}
        <LongRows
          items={lines}
          virtualAbove={windowAbove}
          estimate={rowHeight}
          handle={rows}
          rowKey={(_, index) => String(index)}
          render={(line, index) => (
            <div
              data-log-line={index}
              className={cn(
                "flex min-w-max gap-3 px-2 whitespace-pre",
                errors.has(index) ? "text-status-failed" : "text-foreground",
                index === selected && "bg-active",
              )}
            >
              <span
                aria-hidden
                className="w-10 shrink-0 text-right text-faint-foreground tabular-nums select-none"
              >
                {index + 1}
              </span>
              <span>{highlight(line, query)}</span>
            </div>
          )}
        />
      </div>
    </div>
  );
}
