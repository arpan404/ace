import {
  ArrowDownIcon,
  ArrowUpIcon,
  MagnifyingGlassIcon,
  TextAaIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { cn } from "@/lib/cn.ts";
import {
  defaultFindOptions,
  findMatches,
  rowColumn,
  startingMatch,
  stepMatch,
  type FindOptions,
  type FindResult,
} from "./search.ts";
import type { SurfaceText, TerminalSurface } from "./surface.ts";

/** Typing settles this long before the scrollback is searched. */
const settleMs = 120;
const none: FindResult = { matches: [], truncated: false };

type Located = { text: SurfaceText; result: FindResult };

function locate(
  surface: RefObject<TerminalSurface | null>,
  query: string,
  options: FindOptions,
): Located | undefined {
  const text = surface.current?.text();
  return text ? { text, result: findMatches(text.lines, query, options) } : undefined;
}

/** Select match `index` in the output and scroll to it; clear the selection when there is none. */
function reveal(
  surface: RefObject<TerminalSurface | null>,
  found: Located | undefined,
  index: number,
) {
  const match = found?.result.matches[index];
  if (!found || !match) return surface.current?.unmark();
  const at = rowColumn(found.text.starts, match, found.text.columns);
  surface.current?.reveal(at.row, at.column, match.end - match.start);
}

/**
 * Find in the scrollback: floats over the output's top-right corner. Enter and Shift+Enter
 * step through matches (from the newest up), Escape closes and returns to the output. Each
 * step searches what the output holds now, so new lines are found too.
 */
export function FindBar(props: {
  surface: RefObject<TerminalSurface | null>;
  /** Close and give focus back to the output. */
  onClose(): void;
}) {
  const { surface } = props;
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<FindOptions>(defaultFindOptions);
  const [result, setResult] = useState<FindResult>(none);
  const [current, setCurrent] = useState(-1);
  useEffect(() => input.current?.focus(), []);
  // A new query or option starts again from the newest match.
  useEffect(() => {
    const timer = setTimeout(() => {
      const found = locate(surface, query, options);
      const index = found ? startingMatch(found.result.matches) : -1;
      setResult(found?.result ?? none);
      setCurrent(index);
      reveal(surface, found, index);
    }, settleMs);
    return () => clearTimeout(timer);
  }, [surface, query, options]);
  const step = (delta: 1 | -1) => {
    const found = locate(surface, query, options);
    const index = found ? stepMatch(found.result.matches.length, current, delta) : -1;
    setResult(found?.result ?? none);
    setCurrent(index);
    reveal(surface, found, index);
  };
  const close = () => {
    surface.current?.unmark();
    props.onClose();
  };
  const count = result.matches.length;
  const status = result.error
    ? "Invalid expression"
    : !query
      ? ""
      : count === 0
        ? "No results"
        : `${current + 1} of ${count}${result.truncated ? "+" : ""}`;
  return (
    <div
      role="search"
      aria-label="Find in output"
      className="absolute top-2 right-3 z-10 flex h-8 items-center gap-0.5 rounded-lg border bg-popover pr-1 pl-2 shadow-[var(--glass-shadow)]"
    >
      <MagnifyingGlassIcon aria-hidden size={14} className="shrink-0 text-subtle-foreground" />
      <input
        ref={input}
        type="search"
        aria-label="Find"
        aria-invalid={result.error ? true : undefined}
        placeholder="Find"
        value={query}
        spellCheck={false}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            step(event.shiftKey ? -1 : 1);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
        className="h-6 w-40 min-w-0 bg-transparent px-1.5 text-ui text-foreground outline-none placeholder:text-subtle-foreground [&::-webkit-search-cancel-button]:hidden"
      />
      <span
        role="status"
        className={cn(
          "min-w-[64px] shrink-0 px-1 text-right text-xs tabular-nums text-subtle-foreground",
          result.error && "text-status-failed",
        )}
      >
        {status}
      </span>
      <IconButton
        icon={TextAaIcon}
        label="Match case"
        size="sm"
        pressed={options.caseSensitive}
        onClick={() => setOptions((value) => ({ ...value, caseSensitive: !value.caseSensitive }))}
      />
      <button
        type="button"
        aria-label="Use regular expression"
        aria-pressed={options.regex}
        title="Use regular expression"
        onClick={() => setOptions((value) => ({ ...value, regex: !value.regex }))}
        className="inline-grid size-6 shrink-0 place-items-center rounded-sm font-mono text-[11px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--ring)] aria-pressed:bg-accent aria-pressed:text-foreground"
      >
        .*
      </button>
      <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
      <IconButton
        icon={ArrowUpIcon}
        label="Previous match"
        keys="shift+enter"
        size="sm"
        disabled={count === 0}
        onClick={() => step(-1)}
      />
      <IconButton
        icon={ArrowDownIcon}
        label="Next match"
        keys="enter"
        size="sm"
        disabled={count === 0}
        onClick={() => step(1)}
      />
      <IconButton icon={XIcon} label="Close find" keys="escape" size="sm" onClick={close} />
    </div>
  );
}
