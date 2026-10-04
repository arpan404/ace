import { XIcon } from "@phosphor-icons/react";
import type { DragEvent, KeyboardEvent } from "react";
import { Icon } from "@/components/icon.tsx";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.tsx";
import { MenuItem, MenuSeparator } from "@/components/ui/menu.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { keymap } from "@/lib/keymap.ts";
import type {
  Dock,
  WorkspaceActions,
  WorkspaceDefinition,
  WorkspaceTab,
} from "@/lib/workspace/index.ts";
import { tabDomId } from "./tab-content.tsx";

/** Dragged tabs carry their key under this type, so a strip can tell a tab drag from a file. */
export const tabDragType = "application/x-ace-workspace-tab";

export type DropSide = "before" | "after";

/**
 * One tab: icon, title, live badge and a close button whose room is always kept, so the strip
 * never shifts on hover. Pinned tool tabs have no close button (their menu still closes them).
 * Right-click (or the context-menu key) for pin, move and close actions.
 */
export function TabItem(props: {
  scope: string;
  dock: Dock;
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
  onKeyDown(event: KeyboardEvent<HTMLButtonElement>): void;
  onDragOver(event: DragEvent<HTMLElement>, side: DropSide): void;
}) {
  const { tab, definition, actions } = props;
  const kind = definition.kind(tab.kind);
  const title = definition.title(tab);
  const other: Dock = props.dock === "right" ? "bottom" : "right";
  const canMove = kind?.docks.includes(other) ?? false;
  const Badge = kind?.Badge;
  const closable = !tab.pinned;
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            data-tab-key={tab.key}
            draggable
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
              !tab.pinned && "max-w-[220px] min-w-[88px] shrink",
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
        <button
          type="button"
          role="tab"
          id={tabDomId(props.dock, tab.key, "tab")}
          aria-controls={tabDomId(props.dock, tab.key, "panel")}
          aria-selected={props.active}
          tabIndex={props.focusable ? 0 : -1}
          title={title}
          onClick={() => actions.activate(tab.key)}
          onAuxClick={(event) => {
            // Middle-click closes, as in a browser.
            if (event.button === 1 && closable) actions.close(tab.key);
          }}
          onKeyDown={props.onKeyDown}
          className={cn(
            "flex h-7 w-full min-w-0 items-center gap-1.5 rounded-[7px] pl-2 text-sm font-medium whitespace-nowrap text-muted-foreground outline-none",
            "transition-[color,background-color,box-shadow] duration-(--dur-1)",
            "hover:text-foreground hover:not-aria-selected:bg-[color-mix(in_oklab,var(--foreground)_4%,transparent)]",
            "focus-visible:text-foreground focus-visible:shadow-[0_0_0_2px_color-mix(in_oklab,var(--ring)_70%,transparent)]",
            "aria-selected:bg-[color-mix(in_oklab,var(--foreground)_8%,transparent)] aria-selected:text-foreground",
            closable ? "pr-7" : "pr-2.5",
          )}
        >
          <Icon
            icon={kind?.icon ?? XIcon}
            size={14}
            active={props.active}
            className="text-current opacity-80"
          />
          <span className="min-w-0 truncate">{title}</span>
          {Badge && <Badge scope={props.scope} tab={tab} />}
        </button>
        {closable && (
          <Tip label={`Close ${title}`} shortcut="closeTab">
            <button
              type="button"
              tabIndex={-1}
              aria-label={`Close ${title}`}
              onClick={() => actions.close(tab.key)}
              className={cn(
                "absolute top-1/2 right-1 grid size-5 -translate-y-1/2 place-items-center rounded-[5px] text-subtle-foreground outline-none",
                "opacity-0 transition-[opacity,background-color,color] duration-(--dur-1) group-hover/tab:opacity-100 hover:bg-accent hover:text-foreground",
                props.active && "opacity-100",
              )}
            >
              <XIcon aria-hidden size={12} weight="bold" />
            </button>
          </Tip>
        )}
      </ContextMenuTrigger>
      <ContextMenuContent>
        {props.dock === "right" && (
          <MenuItem
            keys={keymap.fullView.keys}
            onClick={() => {
              actions.activate(tab.key);
              actions.setExpanded(true);
            }}
          >
            Open in full view
          </MenuItem>
        )}
        {canMove && (
          <MenuItem onClick={() => actions.moveToDock(tab.key, other)}>
            {other === "bottom" ? "Move to bottom panel" : "Move to side panel"}
          </MenuItem>
        )}
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
        <MenuItem keys={keymap.closeTab.keys} onClick={() => actions.close(tab.key)}>
          Close tab
        </MenuItem>
        <MenuItem disabled={props.count < 2} onClick={() => actions.closeOthers(tab.key)}>
          Close other tabs
        </MenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
