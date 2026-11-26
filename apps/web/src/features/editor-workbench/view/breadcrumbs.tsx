import { CaretRightIcon, CheckIcon } from "@ace/icons";
import { symbolTrailAt, type OutlineSymbol } from "@ace/ui-core/editor-workbench";
import { Fragment, useMemo, type ReactNode } from "react";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu.tsx";
import { cn } from "@/lib/cn.ts";
import { SymbolIcon } from "./symbol-icon.tsx";

/** Where the trail starts before the editor has said where its text starts. */
const defaultInset = 12;

/**
 * The 26px line under a strip: the file's folders, name, and active symbol trail in mono
 * (`… › workspace-tabs.ts › closeTab`), starting where the code's text starts so the two read as
 * one column. The folders give way first (they truncate from their start), so the file's name and
 * active symbol stay readable. Clicking a symbol opens a sibling jump menu.
 */
export function Breadcrumbs(props: {
  path: string | undefined;
  /** The editor's text column, in px from the group's left edge. */
  textStart?: number | undefined;
  /** Document symbols for the active file, used to render the symbol trail at `caretLine`. */
  symbols?: readonly OutlineSymbol[] | undefined;
  /** 1-based caret line in this pane's editor. */
  caretLine?: number | undefined;
  /** Jump to a picked symbol from the breadcrumb trail. */
  onRevealSymbol?: ((symbol: OutlineSymbol) => void) | undefined;
  /** At the line's right end: Markdown's Preview / Source choice (spec 40). */
  end?: ReactNode;
  /** Extra classes on the breadcrumb bar (e.g. hiding desktop chrome in a narrow panel). */
  className?: string | undefined;
}) {
  const { symbols, caretLine, onRevealSymbol } = props;
  const trail = useMemo(
    () => (symbols && caretLine ? symbolTrailAt(symbols, caretLine) : []),
    [symbols, caretLine],
  );

  if (props.path === undefined)
    return <div aria-hidden className={cn("h-[26px] shrink-0", props.className)} />;
  const segments = props.path.split("/");
  const name = segments.pop() ?? props.path;

  return (
    <div className={cn("flex h-[26px] shrink-0 items-center gap-2 pr-1.5", props.className)}>
      <nav
        aria-label="File path"
        style={{ paddingLeft: props.textStart ?? defaultInset }}
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden pr-3 font-mono text-xs whitespace-nowrap text-subtle-foreground"
      >
        {segments.length > 0 && (
          // rtl clips the start, keeping the folders nearest the file; the bdi keeps their order.
          <span className="min-w-0 truncate [direction:rtl]">
            <bdi className="[direction:ltr]">
              {segments.map((segment, index) => (
                <Fragment key={segments.slice(0, index + 1).join("/")}>
                  {segment}
                  <CaretRightIcon
                    aria-hidden
                    size={10}
                    className="mx-1 inline-block align-[-1px] text-faint-foreground"
                  />
                </Fragment>
              ))}
            </bdi>
          </span>
        )}
        <span
          aria-current={trail.length === 0 ? "page" : undefined}
          className={cn(
            "shrink-0",
            trail.length === 0 ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {name}
        </span>
        {trail.map((symbol, index) => {
          const siblings = index === 0 ? (symbols ?? []) : (trail[index - 1]?.children ?? []);
          const last = index === trail.length - 1;
          return (
            <Fragment key={`${symbol.line}:${symbol.column}:${symbol.name}`}>
              <CaretRightIcon
                aria-hidden
                size={10}
                className="mx-0.5 shrink-0 text-faint-foreground"
              />
              <SymbolCrumb
                symbol={symbol}
                siblings={siblings}
                current={last}
                onSelect={onRevealSymbol}
              />
            </Fragment>
          );
        })}
      </nav>
      {props.end}
    </div>
  );
}

function SymbolCrumb(props: {
  symbol: OutlineSymbol;
  siblings: readonly OutlineSymbol[];
  current: boolean;
  onSelect?: ((symbol: OutlineSymbol) => void) | undefined;
}) {
  const { symbol, siblings, current, onSelect } = props;
  const label = (
    <>
      <SymbolIcon kind={symbol.kind} size={12} />
      <span className="max-w-[180px] truncate">{symbol.name}</span>
    </>
  );

  if (!onSelect || siblings.length <= 1) {
    return (
      <button
        type="button"
        aria-current={current ? "location" : undefined}
        onClick={() => onSelect?.(symbol)}
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-sm px-1 py-0.5 transition-colors duration-(--motion-fast) focus-ring-inset hover:bg-hover hover:text-foreground",
          current ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
      </button>
    );
  }

  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-current={current ? "location" : undefined}
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-sm px-1 py-0.5 transition-colors duration-(--motion-fast) focus-ring-inset hover:bg-hover hover:text-foreground",
              current ? "text-foreground" : "text-muted-foreground",
            )}
          />
        }
      >
        {label}
      </MenuTrigger>
      <MenuContent className="max-h-72 min-w-[200px] overflow-y-auto">
        {siblings.map((item) => {
          const active = item.line === symbol.line && item.name === symbol.name;
          return (
            <MenuItem
              key={`${item.line}:${item.column}:${item.name}`}
              onClick={() => onSelect(item)}
              className="gap-2 font-mono text-xs"
            >
              <SymbolIcon kind={item.kind} size={13} />
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              <span className="text-faint-foreground tabular-nums">:{item.line}</span>
              {active && <CheckIcon aria-hidden size={12} className="shrink-0 text-foreground" />}
            </MenuItem>
          );
        })}
      </MenuContent>
    </Menu>
  );
}
