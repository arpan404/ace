import { XIcon } from "@phosphor-icons/react";
import type { DragEvent, KeyboardEvent } from "react";
import { Icon } from "@/components/icon.tsx";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.tsx";
import { MenuItem, MenuSeparator } from "@/components/ui/menu.tsx";
import { Tip, Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import type { WorkspaceActions, WorkspaceDefinition, WorkspaceTab } from "@/lib/workspace/index.ts";
import { tabDomId } from "./tab-content.tsx";

/** Dragged tabs carry their key under this type, so a strip can tell a tab drag from a file. */
export const tabDragType = "application/x-ace-workspace-tab";

export type DropSide = "before" | "after";

/**
 * A tab's width without its title or badge: 8px lead, 14px icon, 6px gap, then 28px of close
 * room on the showing tab (10px on the others, whose close shows over the title's end on hover,
 * and on a pinned tab, which has none). The strip's layout pass adds the measured title.
 */
export const tabChrome = (closeRoom: boolean) => 8 + 14 + 6 + (closeRoom ? 28 : 10);
const badgeGap = 6;
/** A folded tab's badge dot: just off the top right of its centred 14px icon. */
const dotPlace = { top: 3, left: "calc(50% + 5px)" };
/** A tab's natural width, independent of its current rendered width. */
export function measureTab(element: HTMLElement): number {
  const title = element.querySelector<HTMLElement>("[data-tab-title]")?.scrollWidth ?? 0;
  const badge = element.querySelector<HTMLElement>("[data-tab-badge]")?.scrollWidth ?? 0;
  // +1: scrollWidth rounds, and half a pixel short would ellipsize the showing tab's title.
  const fixed =
    1 + tabChrome(element.dataset.closeRoom === "true") + (badge > 0 ? badgeGap + badge : 0);
  return fixed + title;
}

/**
 * One tab: icon, title, live badge and a close button whose room is always kept, so the strip
 * never shifts on hover. Pinned tool tabs have no close button (their menu still closes them).
 * Right-click (or the context-menu key) for full view, pin, move and close actions.
 */
export function TabItem(props: {
  scope: string;
  tab: WorkspaceTab;
  index: number;
  count: number;
  active: boolean;
  /** This tab holds the strip's single tab stop. */
  focusable: boolean;
  definition: WorkspaceDefinition;
  actions: WorkspaceActions;
  drop: DropSide | undefined;
  entering: boolean;
  /** From the strip's layout pass; until it has run, CSS bounds the tab. */
  width: number | undefined;
  /** Folded to its icon: the strip is short and this isn't the showing tab. */
  iconOnly: boolean;
  /** Drawn narrower than its title: the tooltip carries the whole title. */
  clipped: boolean;
  /** Drawn with its badge's dot in place of the badge (the strip is a little short). */
  badgeDot: boolean;
  onKeyDown(event: KeyboardEvent<HTMLButtonElement>): void;
  onDragOver(event: DragEvent<HTMLElement>, side: DropSide): void;
}) {
  const { tab, definition, actions } = props;
  const kind = definition.kind(tab.kind);
  const title = definition.title(tab);
  const Badge = kind?.Badge;
  const closable = !tab.pinned;
  const iconOnly = props.iconOnly;
  const badgeDot = props.badgeDot && !iconOnly;
  const closeLabel = kind?.closeLabel ?? "Close";
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            data-tab-key={tab.key}
            data-close-room={closable && props.active}
            draggable
            style={props.width === undefined ? undefined : { width: props.width }}
            onDragStart={(event) => {
              event.dataTransfer.setData(tabDragType, tab.key);
              event.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              props.onDragOver(
                event,
                event.clientX < rect.left + rect.width / 2 ? "before" : "after",
              );
            }}
            className={cn(
              "group/tab relative flex h-7 min-w-0 shrink-0 items-center [-webkit-app-region:no-drag]",
              props.width === undefined && !tab.pinned && "max-w-[220px] min-w-[88px] shrink",
              props.entering && "fx-pop",
            )}
          />
        }
      >
        {props.drop && (
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-y-1 z-[1] w-0.5 rounded-full bg-ring",
              props.drop === "before" ? "-left-[2px]" : "-right-[2px]",
            )}
          />
        )}
        {/* Folded or clipped, the tab's whole title shows as a tooltip (on keyboard focus too). */}
        <Tooltip
          disabled={!iconOnly && !props.clipped}
          onOpenChange={(open, details) => {
            // A title tooltip must not consume Escape meant for the containing sheet.
            if (open && details.reason === "trigger-focus") details.cancel();
          }}
        >
          <TooltipTrigger
            delay={400}
            render={
              <button
                type="button"
                role="tab"
                id={tabDomId(tab.key, "tab")}
                aria-controls={tabDomId(tab.key, "panel")}
                aria-selected={props.active}
                aria-label={iconOnly ? title : undefined}
                tabIndex={props.focusable ? 0 : -1}
                onClick={() => actions.activate(tab.key)}
                onAuxClick={(event) => {
                  // Middle-click closes, as in a browser.
                  if (event.button === 1 && closable) void actions.close(tab.key);
                }}
                onKeyDown={(event) => {
                  // Shift+F10 opens the tab's menu from the keyboard (Mac keyboards have no
                  // context-menu key), anchored under the tab.
                  if (event.key === "F10" && event.shiftKey) {
                    event.preventDefault();
                    openMenuFromKeyboard(event.currentTarget);
                    return;
                  }
                  props.onKeyDown(event);
                }}
                className={cn(
                  "focus-ring flex h-7 w-full min-w-0 items-center gap-1.5 rounded-sm pl-2 text-sm font-medium whitespace-nowrap text-muted-foreground",
                  "transition-[color,background-color,box-shadow] duration-(--dur-1)",
                  "hover:text-foreground hover:not-aria-selected:bg-foreground/5",
                  "focus-visible:text-foreground",
                  "aria-selected:bg-foreground/8 aria-selected:text-foreground",
                  iconOnly
                    ? "justify-center gap-0 px-0"
                    : !closable
                      ? "pr-2.5"
                      : props.active
                        ? "pr-7"
                        : // The strip sized the tab, so making room for the close never moves it.
                          "pr-2.5 group-focus-within/tab:pr-7 group-hover/tab:pr-7 pointer-coarse:pr-7",
                )}
              />
            }
          >
            {kind?.TabIcon ? (
              <kind.TabIcon
                scope={props.scope}
                tab={tab}
                className="shrink-0 text-current opacity-80"
              />
            ) : (
              <Icon
                icon={kind?.icon ?? XIcon}
                size={14}
                active={props.active}
                className="shrink-0 text-current opacity-80"
              />
            )}
            {/* Folded, the title and badge keep their width to measure but take no room. */}
            <span data-tab-title className={cn("min-w-0 truncate", iconOnly && "w-0")}>
              {title}
            </span>
            {Badge && (
              <span
                data-tab-badge
                className={cn(
                  "flex min-w-0 shrink-0 items-center empty:hidden",
                  (iconOnly || badgeDot) && "absolute w-0 overflow-hidden",
                )}
              >
                <Badge scope={props.scope} tab={tab} />
              </span>
            )}
            {/* Short of room, the badge gives way to its dot beside the title (Changes: "has
                changes"); the badge above stays, out of sight, for the layout pass to measure. */}
            {Badge && badgeDot && (
              <span aria-hidden data-tab-dot className="flex shrink-0 empty:hidden">
                <Badge scope={props.scope} tab={tab} folded />
              </span>
            )}
            {/* Folded, a badge keeps its signal as a dot at the icon's corner. */}
            {Badge && iconOnly && (
              <span
                aria-hidden
                data-tab-dot
                style={dotPlace}
                className="pointer-events-none absolute flex empty:hidden"
              >
                <Badge scope={props.scope} tab={tab} folded />
              </span>
            )}
          </TooltipTrigger>
          <TooltipContent side="bottom">{title}</TooltipContent>
        </Tooltip>
        {closable && !iconOnly && (
          <Tip label={kind?.closeLabel ?? `Close ${title}`} shortcut="closeTab">
            <button
              type="button"
              tabIndex={-1}
              aria-label={`${closeLabel} ${title}`}
              onClick={() => void actions.close(tab.key)}
              className={cn(
                "absolute top-1/2 right-1 grid size-5 -translate-y-1/2 place-items-center rounded-xs text-subtle-foreground outline-none",
                "opacity-0 transition-[opacity,background-color,color] duration-(--dur-1) group-hover/tab:opacity-100 pointer-coarse:opacity-100 hover:bg-accent hover:text-foreground",
                props.active && "opacity-100",
              )}
            >
              <XIcon aria-hidden size={12} weight="bold" />
            </button>
          </Tip>
        )}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <MenuItem
          shortcut="fullView"
          onClick={() => {
            actions.activate(tab.key);
            actions.setExpanded(true);
          }}
        >
          Open in full view
        </MenuItem>
        <MenuItem onClick={() => actions.setPinned(tab.key, !tab.pinned)}>
          {tab.pinned ? "Unpin tab" : "Pin tab"}
        </MenuItem>
        <MenuItem
          disabled={props.index === 0}
          onClick={() => actions.move(tab.key, props.index - 1)}
        >
          Move left
        </MenuItem>
        <MenuItem
          disabled={props.index === props.count - 1}
          onClick={() => actions.move(tab.key, props.index + 1)}
        >
          Move right
        </MenuItem>
        <MenuSeparator />
        <MenuItem shortcut="closeTab" onClick={() => void actions.close(tab.key)}>
          {kind?.closeLabel ?? "Close tab"}
        </MenuItem>
        <MenuItem disabled={props.count < 2} onClick={() => void actions.closeOthers(tab.key)}>
          Close other tabs
        </MenuItem>
        <MenuItem shortcut="reopenTab" onClick={() => actions.reopen()}>
          Reopen closed tab
        </MenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Open a tab's context menu from the keyboard, anchored under its bottom-left corner. */
function openMenuFromKeyboard(tab: HTMLElement): void {
  const rect = tab.getBoundingClientRect();
  tab.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left,
      clientY: rect.bottom,
    }),
  );
}
