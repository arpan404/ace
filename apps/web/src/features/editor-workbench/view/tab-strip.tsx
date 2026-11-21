import { CaretDownIcon, DotsThreeIcon } from "@ace/icons";
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu.tsx";
import { EditorTabView } from "./editor-tab.tsx";
import type { EditorBuffers } from "./editor-buffers.ts";
import { carriesTab, copiesOnDrop, readTabDrag } from "./drag.ts";
import type { GroupActions } from "./group-actions.ts";
import { tabLabels, type GroupNode } from "@ace/ui-core/editor-workbench";
import { fileName, folderOf } from "./paths.ts";
import { TabMenu } from "./tab-menu.tsx";

/**
 * One group's strip: its tabs (one tab stop; arrows move, Delete closes), a drop slot while a
 * tab is dragged over it, a ⌄ listing every tab while they overflow, and the group's ⋯.
 */
export function TabStrip(props: {
  group: GroupNode;
  focused: boolean;
  buffers: EditorBuffers;
  actions: GroupActions;
  /** Room before the tabs (compact layout's "Show files"). */
  lead?: ReactNode;
  /** Extra items for the ⋯ menu (compact layout lists the other groups). */
  groupMenu?: ReactNode;
  /** The host's items at the end of each tab's menu. */
  tabMenuItems?: ((path: string) => ReactNode) | undefined;
}) {
  const { group, actions } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const [drop, setDrop] = useState<number | undefined>(undefined);
  const overflowing = useOverflow(scroller, group.tabs.length);
  const labels = tabLabels(group.tabs.map((tab) => tab.path));
  const activeIndex = Math.max(
    0,
    group.tabs.findIndex((tab) => tab.path === group.active),
  );

  // The active tab always scrolls into view (spec 28).
  const active = group.active;
  useLayoutEffect(() => {
    if (active === undefined) return;
    const shown = scroller.current?.querySelector<HTMLElement>(
      `[data-path="${CSS.escape(active)}"]`,
    );
    shown?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [active]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>, index: number) => {
    const tabs = group.tabs;
    const step = (to: number) => {
      const next = tabs[(to + tabs.length) % tabs.length];
      if (!next) return;
      event.preventDefault();
      actions.activate(next.path);
      scroller.current
        ?.querySelector<HTMLElement>(`[data-path="${CSS.escape(next.path)}"]`)
        ?.focus();
    };
    if (event.key === "ArrowRight") step(index + 1);
    else if (event.key === "ArrowLeft") step(index - 1);
    else if (event.key === "Home") step(0);
    else if (event.key === "End") step(tabs.length - 1);
    else if (event.key === "Delete" || event.key === "Backspace") {
      const tab = tabs[index];
      if (tab) actions.close([tab.path]);
    }
  };

  return (
    <div
      data-part="editor-strip"
      className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border pr-1 pl-1.5"
    >
      {props.lead}
      <div
        ref={scroller}
        role="tablist"
        aria-label="Open files"
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]"
        onDragOver={(event) => {
          if (!carriesTab(event.dataTransfer)) return;
          event.preventDefault();
          if (event.target === event.currentTarget) setDrop(group.tabs.length);
        }}
        onDragLeave={(event) => {
          const into = event.relatedTarget;
          if (!(into instanceof Node && event.currentTarget.contains(into))) setDrop(undefined);
        }}
        onDrop={(event) => {
          const drag = readTabDrag(event.dataTransfer);
          const index = drop ?? group.tabs.length;
          setDrop(undefined);
          if (!drag) return;
          event.preventDefault();
          event.stopPropagation();
          actions.dropInStrip(drag, index, copiesOnDrop(event));
        }}
      >
        {group.tabs.map((tab, index) => (
          <div key={tab.path} className="relative flex shrink-0">
            {drop === index && <DropMark side="before" />}
            {drop === index + 1 && index === group.tabs.length - 1 && <DropMark side="after" />}
            <TabMenu
              group={group}
              tab={tab}
              actions={actions}
              extra={props.tabMenuItems?.(tab.path)}
            >
              <EditorTabView
                group={group.id}
                tab={tab}
                hint={labels[index]?.folder}
                active={tab.path === group.active}
                groupFocused={props.focused}
                focusable={index === activeIndex}
                buffers={props.buffers}
                onActivate={() => actions.activate(tab.path)}
                onKeep={() => actions.keep(tab.path)}
                onClose={() => actions.close([tab.path])}
                onKeyDown={(event) => onKeyDown(event, index)}
                onDragOver={(event, after) => {
                  if (!carriesTab(event.dataTransfer)) return;
                  event.preventDefault();
                  setDrop(after ? index + 1 : index);
                }}
              />
            </TabMenu>
          </div>
        ))}
      </div>
      {overflowing && <OverflowMenu group={group} actions={actions} />}
      <Menu>
        <MenuTrigger render={<IconButton label="Group actions" size="sm" icon={DotsThreeIcon} />} />
        <MenuContent align="end">
          {props.groupMenu}
          <MenuItem
            disabled={!group.active}
            onClick={() => group.active && actions.splitTab(group.active, "right")}
          >
            Split right
          </MenuItem>
          <MenuItem
            disabled={!group.active}
            onClick={() => group.active && actions.splitTab(group.active, "down")}
          >
            Split down
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            disabled={group.tabs.length === 0}
            onClick={() => actions.close(group.tabs.map((tab) => tab.path))}
          >
            Close all
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}

function DropMark(props: { side: "before" | "after" }) {
  return (
    <span
      aria-hidden
      data-drop-mark=""
      className={`pointer-events-none absolute inset-y-1 z-[1] w-0.5 rounded-full bg-ring ${props.side === "before" ? "-left-[2px]" : "-right-[2px]"}`}
    />
  );
}

/** Spec 28: shown only while the tabs overflow; lists them with their folders. */
function OverflowMenu(props: { group: GroupNode; actions: GroupActions }) {
  return (
    <Menu>
      <MenuTrigger render={<IconButton label="All open files" size="sm" icon={CaretDownIcon} />} />
      <MenuContent align="end">
        {props.group.tabs.map((tab) => (
          <MenuItem key={tab.path} onClick={() => props.actions.activate(tab.path)}>
            <span className={tab.preview ? "italic" : undefined}>{fileName(tab.path)}</span>
            <span className="ml-2 text-subtle-foreground">{folderOf(tab.path)}</span>
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

function useOverflow(scroller: React.RefObject<HTMLDivElement | null>, count: number): boolean {
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    // One tab never needs the list, even when it is wider than the strip.
    const measure = () =>
      setOverflowing(count > 1 && element.scrollWidth > element.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [scroller, count]);
  return overflowing;
}
