import { MagnifyingGlassIcon } from "@ace/icons";
import { fuzzyPositions } from "@ace/ui-core";
import {
  flattenSymbols,
  type FlatOutlineSymbol,
  type OutlineSymbol,
} from "@ace/ui-core/editor-workbench";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { CommandDialog } from "@/components/ui/command.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { SymbolIcon, symbolKindLabel } from "@/features/editor-workbench/index.ts";
import { cn } from "@/lib/cn.ts";

function HighlightedName(props: { name: string; query: string }) {
  const positions = props.query ? (fuzzyPositions(props.query, props.name) ?? []) : [];
  const hits = new Set(positions);
  const parts: ReactNode[] = [];
  for (let i = 0; i < props.name.length; i++) {
    parts.push(
      hits.has(i) ? (
        <b key={i} className="font-semibold text-foreground">
          {props.name[i]}
        </b>
      ) : (
        props.name[i]
      ),
    );
  }
  return <span className="min-w-0 truncate font-mono text-foreground">{parts}</span>;
}

/**
 * ⇧⌘O: Go to symbol in the active editor file. Reuses quick open's `CommandDialog` popover look,
 * filters with fuzzy matching, and jumps focus to the chosen symbol on Enter or click.
 */
export function GoToSymbolDialog(props: {
  path: string;
  symbols: readonly OutlineSymbol[];
  onPick(symbol: OutlineSymbol): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();

  const all = useMemo(() => flattenSymbols(props.symbols), [props.symbols]);
  const rows = useMemo<readonly FlatOutlineSymbol[]>(() => {
    const trimmed = query.trim();
    if (!trimmed) return all;
    const matched: { row: FlatOutlineSymbol; score: number }[] = [];
    const lower = trimmed.toLowerCase();
    for (const row of all) {
      const target = row.container ? `${row.container}.${row.symbol.name}` : row.symbol.name;
      const positions = fuzzyPositions(trimmed, row.symbol.name) ?? fuzzyPositions(trimmed, target);
      if (!positions) continue;
      const nameLower = row.symbol.name.toLowerCase();
      const score = nameLower.startsWith(lower) ? 0 : nameLower.includes(lower) ? 1 : 2;
      matched.push({ row, score });
    }
    matched.sort((a, b) => a.score - b.score || a.row.symbol.line - b.row.symbol.line);
    return matched.map((entry) => entry.row);
  }, [all, query]);

  const current = Math.min(active, Math.max(0, rows.length - 1));
  const optionId = (index: number) => `${listId}-${index}`;

  useEffect(() => {
    document.getElementById(optionId(current))?.scrollIntoView?.({ block: "nearest" });
  });

  const choose = (row: FlatOutlineSymbol | undefined) => {
    if (!row) return;
    props.onClose();
    props.onPick(row.symbol);
  };

  const fileName = props.path.split("/").at(-1) ?? props.path;

  return (
    <CommandDialog open onOpenChange={(open) => !open && props.onClose()} title="Go to symbol">
      <div className="flex h-[52px] shrink-0 items-center gap-2.5 border-b px-4">
        <MagnifyingGlassIcon aria-hidden size={18} className="shrink-0 text-muted-foreground" />
        <input
          role="combobox"
          aria-label="Go to symbol"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={rows.length ? optionId(current) : undefined}
          placeholder={`Go to symbol in ${fileName}`}
          value={query}
          spellCheck={false}
          autoComplete="off"
          autoFocus
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" && rows.length) {
              event.preventDefault();
              setActive((index) => (index + 1) % rows.length);
            } else if (event.key === "ArrowUp" && rows.length) {
              event.preventDefault();
              setActive((index) => (index - 1 + rows.length) % rows.length);
            } else if (event.key === "Home" && rows.length) {
              event.preventDefault();
              setActive(0);
            } else if (event.key === "End" && rows.length) {
              event.preventDefault();
              setActive(rows.length - 1);
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(rows[current]);
            }
          }}
          className="flex-1 bg-transparent text-ui-lg text-foreground outline-none placeholder:text-subtle-foreground"
        />
        <Kbd>esc</Kbd>
      </div>

      <div
        id={listId}
        role="listbox"
        aria-label="Symbols"
        className="min-h-0 flex-1 overflow-y-auto py-1.5"
      >
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-ui text-subtle-foreground">
            {query.trim() ? `No symbols match “${query.trim()}”.` : "No symbols in this file."}
          </p>
        ) : (
          rows.map((row, index) => {
            const selected = index === current;
            return (
              <div
                key={`${row.symbol.line}:${row.symbol.column}:${row.symbol.kind}:${row.symbol.name}`}
                id={optionId(index)}
                role="option"
                aria-selected={selected}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(row);
                }}
                className={cn(
                  "mx-1.5 flex h-9 cursor-pointer items-center gap-2.5 rounded-sm px-2.5 text-ui",
                  selected ? "bg-active text-foreground" : "text-muted-foreground hover:bg-hover",
                )}
              >
                <SymbolIcon kind={row.symbol.kind} size={15} />
                <HighlightedName name={row.symbol.name} query={query.trim()} />
                {row.container && (
                  <span className="min-w-0 truncate text-xs text-subtle-foreground">
                    {row.container}
                  </span>
                )}
                <span className="ml-auto shrink-0 text-xs text-subtle-foreground">
                  {symbolKindLabel[row.symbol.kind]}
                </span>
                <span className="shrink-0 font-mono text-xs text-faint-foreground tabular-nums">
                  :{row.symbol.line}
                </span>
              </div>
            );
          })
        )}
      </div>

      <div className="flex h-8 shrink-0 items-center justify-between border-t px-4 text-xs text-subtle-foreground">
        <span>
          <Kbd>↑</Kbd> <Kbd>↓</Kbd> to navigate · <Kbd>↵</Kbd> to jump
        </span>
        <span className="tabular-nums">
          {rows.length} {rows.length === 1 ? "symbol" : "symbols"}
        </span>
      </div>
    </CommandDialog>
  );
}
