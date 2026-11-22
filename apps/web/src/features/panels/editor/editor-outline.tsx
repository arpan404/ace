import { ArrowsDownUpIcon, CaretDownIcon, CaretRightIcon, FunnelIcon, XIcon } from "@ace/icons";
import {
  filterSymbols,
  sortSymbols,
  symbolTrailAt,
  type OutlineSort,
  type OutlineSymbol,
} from "@ace/ui-core/editor-workbench";
import { useMemo, useRef, useState } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import {
  SymbolIcon,
  symbolKindLabel,
  useFileOutline,
  useStatusReport,
  type StatusStore,
  type TextBuffer,
} from "@/features/editor-workbench/index.ts";
import { cn } from "@/lib/cn.ts";

/**
 * Collapsible "Outline" section at the bottom of the Files view: lists document symbols for the
 * focused file, highlights the symbol at the caret, filters by typing, sorts by position or name,
 * and reveals a symbol on click.
 */
export function EditorOutline(props: {
  path: string | undefined;
  buffer: TextBuffer | undefined;
  focusedGroupId: string;
  statusStore: StatusStore;
  open: boolean;
  onOpenChange(open: boolean): void;
  sort: OutlineSort;
  onSortChange(sort: OutlineSort): void;
  onReveal(symbol: OutlineSymbol): void;
}) {
  const { path, buffer, focusedGroupId, statusStore, open, onOpenChange, sort, onSortChange } =
    props;
  const report = useStatusReport(statusStore, focusedGroupId);
  const caretLine = report?.status.line;
  const language = report?.status.language ?? path;
  const { symbols } = useFileOutline(open ? buffer : undefined, language);

  const [filtering, setFiltering] = useState(false);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const filterRef = useRef<HTMLInputElement>(null);

  const activeKey = useMemo(() => {
    if (!caretLine) return undefined;
    const trail = symbolTrailAt(symbols, caretLine);
    const leaf = trail.at(-1);
    return leaf ? symbolKey(leaf) : undefined;
  }, [symbols, caretLine]);

  const visible = useMemo(() => {
    const filtered = query ? filterSymbols(symbols, query) : symbols;
    return sortSymbols(filtered, sort);
  }, [symbols, query, sort]);

  const Caret = open ? CaretDownIcon : CaretRightIcon;
  const toggleCollapse = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const openFilter = (seed?: string) => {
    setFiltering(true);
    if (seed !== undefined) setQuery((was) => was + seed);
    requestAnimationFrame(() => filterRef.current?.focus());
  };

  return (
    <section
      aria-label="Outline"
      data-part="editor-outline"
      className="flex shrink-0 flex-col border-t border-border"
    >
      <div className="flex h-7 items-center gap-0.5 pr-1.5 pl-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
          className="flex h-6 min-w-0 flex-1 items-center gap-1 rounded-sm text-xs font-medium text-muted-foreground focus-ring-inset hover:text-foreground"
        >
          <Caret aria-hidden size={12} className="text-faint-foreground" />
          Outline
        </button>
        {open && (
          <div className="flex items-center gap-0.5">
            <IconButton
              label={filtering ? "Hide symbol filter" : "Filter symbols"}
              icon={FunnelIcon}
              size="sm"
              pressed={filtering || query.length > 0}
              onClick={() => {
                if (filtering) {
                  setFiltering(false);
                  setQuery("");
                } else {
                  openFilter();
                }
              }}
              className="size-6 rounded-sm hover:bg-hover"
            />
            <IconButton
              label={sort === "position" ? "Sort by name" : "Sort by position"}
              icon={ArrowsDownUpIcon}
              size="sm"
              pressed={sort === "name"}
              onClick={() => onSortChange(sort === "position" ? "name" : "position")}
              className="size-6 rounded-sm hover:bg-hover"
            />
          </div>
        )}
      </div>

      {open && (
        <div
          role="presentation"
          className="flex flex-col"
          onKeyDown={(event) => {
            if (
              !filtering &&
              event.key.length === 1 &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.altKey
            ) {
              event.preventDefault();
              openFilter(event.key);
            }
          }}
        >
          {filtering && (
            <div className="mx-2 mb-1 flex h-6 items-center gap-1 rounded-sm border border-border-soft bg-background/60 px-1.5">
              <input
                ref={filterRef}
                type="text"
                aria-label="Filter symbols"
                placeholder="Filter symbols"
                value={query}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    if (query) setQuery("");
                    else setFiltering(false);
                  }
                }}
                className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-subtle-foreground"
              />
              {query && (
                <button
                  type="button"
                  aria-label="Clear filter"
                  onClick={() => {
                    setQuery("");
                    filterRef.current?.focus();
                  }}
                  className="inline-flex size-4 items-center justify-center rounded-sm text-faint-foreground hover:text-foreground"
                >
                  <XIcon aria-hidden size={11} />
                </button>
              )}
            </div>
          )}

          <div className="max-h-56 overflow-x-hidden overflow-y-auto pb-1.5">
            {path === undefined ? (
              <p className="px-3 py-2 text-xs text-subtle-foreground">No file open.</p>
            ) : visible.length === 0 ? (
              <p className="px-3 py-2 text-xs text-subtle-foreground">
                {query ? `No symbols match “${query}”.` : "No symbols in this file."}
              </p>
            ) : (
              <ul role="tree" aria-label="Document symbols" className="flex flex-col">
                {visible.map((symbol) => (
                  <OutlineNode
                    key={symbolKey(symbol)}
                    symbol={symbol}
                    depth={0}
                    activeKey={activeKey}
                    collapsed={collapsed}
                    forceExpand={query.length > 0}
                    onToggle={toggleCollapse}
                    onReveal={props.onReveal}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function symbolKey(symbol: OutlineSymbol): string {
  return `${symbol.line}:${symbol.column}:${symbol.kind}:${symbol.name}`;
}

function OutlineNode(props: {
  symbol: OutlineSymbol;
  depth: number;
  activeKey: string | undefined;
  collapsed: ReadonlySet<string>;
  forceExpand: boolean;
  onToggle(key: string): void;
  onReveal(symbol: OutlineSymbol): void;
}) {
  const { symbol, depth, activeKey, collapsed, forceExpand, onToggle, onReveal } = props;
  const key = symbolKey(symbol);
  const hasChildren = symbol.children.length > 0;
  const expanded = forceExpand || !collapsed.has(key);
  const active = key === activeKey;
  const Caret = expanded ? CaretDownIcon : CaretRightIcon;

  return (
    <li role="treeitem" aria-expanded={hasChildren ? expanded : undefined} aria-selected={active}>
      <div
        style={{ paddingLeft: 8 + depth * 12 }}
        className={cn(
          "mx-1.5 flex h-6 items-center gap-1 rounded-sm pr-2 text-xs transition-colors duration-(--motion-fast)",
          active
            ? "bg-active text-foreground"
            : "text-muted-foreground hover:bg-hover hover:text-foreground",
        )}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={expanded ? `Collapse ${symbol.name}` : `Expand ${symbol.name}`}
            onClick={(event) => {
              event.stopPropagation();
              onToggle(key);
            }}
            className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-faint-foreground hover:text-foreground"
          >
            <Caret aria-hidden size={10} />
          </button>
        ) : (
          <span aria-hidden className="size-4 shrink-0" />
        )}
        <button
          type="button"
          aria-current={active ? "true" : undefined}
          title={`${symbolKindLabel[symbol.kind]} ${symbol.name} (line ${symbol.line})`}
          onClick={() => onReveal(symbol)}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left focus-ring-inset"
        >
          <SymbolIcon kind={symbol.kind} size={13} />
          <span className="min-w-0 flex-1 truncate font-mono">{symbol.name}</span>
          <span className="shrink-0 font-mono text-[11px] text-faint-foreground tabular-nums">
            {symbol.line}
          </span>
        </button>
      </div>
      {hasChildren && expanded && (
        <ul role="group" className="flex flex-col">
          {symbol.children.map((child) => (
            <OutlineNode
              key={symbolKey(child)}
              symbol={child}
              depth={depth + 1}
              activeKey={activeKey}
              collapsed={collapsed}
              forceExpand={forceExpand}
              onToggle={onToggle}
              onReveal={onReveal}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
