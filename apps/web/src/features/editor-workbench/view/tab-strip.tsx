import { CaretDownIcon, DotsThreeIcon, SquareSplitHorizontalIcon } from "@ace/icons";
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu.tsx";
import { EditorTabView } from "./editor-tab.tsx";
import type { EditorBuffers } from "./editor-buffers.ts";
import { carriesGroupDrag, copiesOnDrop, readGroupDrag } from "./drag.ts";
import type { GroupActions } from "./group-actions.ts";
import { tabLabels, type GroupNode } from "@ace/ui-core/editor-workbench";
import { fileName, folderOf } from "./paths.ts";
import { TabMenu } from "./tab-menu.tsx";

/**
 * One group's strip: its tabs (one tab stop; arrows move, Delete closes), a drop slot while a
 * tab is dragged over it, a ⌄ listing every tab while they overflow, Split right (⌥: down) and
 * the group's ⋯.
 */
export function TabStrip(props: {
  group: GroupNode;
  focused: boolean;
  buffers: EditorBuffers;
  actions: GroupActions;
  /** Room before the tabs (compact layout's "Show files"). */
  lead?: ReactNode;
  /** The host's items at the end of each tab's menu. */
  tabMenuItems?: ((path: string) => ReactNode) | undefined;
  /** Whose explorer's files may be dropped here. */
  threadId?: string | undefined;
}) {
  const { group, actions } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const [drop, setDrop] = useState<number | undefined>(undefined);
  const edges = useOverflow(scroller, group.tabs.length);
  const overflowing = edges.overflowing;
  const labels = tabLabels(group.tabs.map((tab) => tab.path));
  const activeIndex = Math.max(
    0,
    group.tabs.findIndex((tab) => tab.path === group.active),
  );

  // The active tab always scrolls into view (spec 28), again once the ⌄ takes its room.
  const active = group.active;
  useLayoutEffect(() => {
    if (active === undefined) return;
    const shown = scroller.current?.querySelector<HTMLElement>(
      `[data-path="${CSS.escape(active)}"]`,
    );
    shown?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [active, overflowing, group.tabs.length]);

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
      className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-1.5"
    >
      {props.lead}
      <div
        ref={scroller}
        role="tablist"
        aria-label="Open files"
        // An edge hiding tabs fades instead of cutting a name off.
        style={overflowing ? { maskImage: fadeMask(edges.left, edges.right) } : undefined}
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]"
        onDragOver={(event) => {
          if (!carriesGroupDrag(event.dataTransfer)) return;
          event.preventDefault();
          if (event.target === event.currentTarget) setDrop(group.tabs.length);
        }}
        onDragLeave={(event) => {
          const into = event.relatedTarget;
          if (!(into instanceof Node && event.currentTarget.contains(into))) setDrop(undefined);
        }}
        onDrop={(event) => {
          const drag = readGroupDrag(event.dataTransfer, props.threadId);
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
                  if (!carriesGroupDrag(event.dataTransfer)) return;
                  event.preventDefault();
                  setDrop(after ? index + 1 : index);
                }}
              />
            </TabMenu>
          </div>
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {overflowing && <OverflowMenu group={group} actions={actions} />}
        <IconButton
          label="Split right"
          shortcut="editor.splitRight"
          size="sm"
          icon={SquareSplitHorizontalIcon}
          // An empty group has nothing to show twice.
          disabled={group.active === undefined}
          // ⌥-click splits down, as ⇧⌥⌘\ does.
          onClick={(event) => actions.split(event.altKey ? "down" : "right")}
        />
        <Menu>
          <MenuTrigger
            render={<IconButton label="Group actions" size="sm" icon={DotsThreeIcon} />}
          />
          <MenuContent align="end">
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

/** The strip's mask: each edge that hides tabs fades over 24px. */
function fadeMask(left: boolean, right: boolean): string {
  const start = left ? "transparent, black 24px" : "black, black";
  const end = right ? "black calc(100% - 24px), transparent" : "black, black";
  return `linear-gradient(to right, ${start}, ${end})`;
}

interface Edges {
  /** The tabs are wider than the strip: the ⌄ list shows (spec 28). */
  overflowing: boolean;
  /** Tabs are hidden past the left edge. */
  left: boolean;
  /** Tabs are hidden past the right edge. */
  right: boolean;
}

const fits: Edges = { overflowing: false, left: false, right: false };

function useOverflow(scroller: React.RefObject<HTMLDivElement | null>, count: number): Edges {
  const [edges, setEdges] = useState(fits);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    // One tab never needs the list, even when it is wider than the strip.
    const measure = () => {
      const overflowing = count > 1 && element.scrollWidth > element.clientWidth + 1;
      const next = overflowing
        ? {
            overflowing,
            left: element.scrollLeft > 1,
            right: element.scrollLeft + element.clientWidth < element.scrollWidth - 1,
          }
        : fits;
      setEdges((was) =>
        was.overflowing === next.overflowing && was.left === next.left && was.right === next.right
          ? was
          : next,
      );
    };
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      element.removeEventListener("scroll", measure);
    };
  }, [scroller, count]);
  return edges;
}
