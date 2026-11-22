import {
  activateTab,
  closeTabs,
  copyTab,
  dropFile,
  focusGroup,
  groupsOf,
  keepTab,
  moveTab,
  pinTab,
  findGroup,
  limits,
  splitGroup,
  splitSide,
  setViewState,
  tabsToClose,
  unpinTab,
  type CloseWhich,
  type DropTarget,
  type EditorLayout,
  type NewGroupId,
  type Room,
  type Side,
  type TabRef,
  type ViewState,
} from "@ace/ui-core/editor-workbench";
import type { EditorBuffers } from "./editor-buffers.ts";
import type { GroupDrag } from "./drag.ts";

/** What one group's chrome can do, bound to that group and the layout it was drawn from. */
export interface GroupActions {
  focus(): void;
  activate(path: string): void;
  keep(path: string): void;
  close(paths: readonly string[]): void;
  /** A tab menu's close variant around `path`. */
  closeVariant(path: string, which: CloseWhich): void;
  setPinned(path: string, pinned: boolean): void;
  /** A second view of a tab in a new pane on one side of this one. */
  splitTab(path: string, side: Side): void;
  /**
   * Where a new pane on `side` of this one would go: `side`, or stacked when the panes couldn't
   * sit side by side; undefined at the pane cap (nothing is made).
   */
  edge(side: Side): Side | undefined;
  /** At the pane cap: why no pane can be made ("Up to 4 panes beside the chat"). */
  capped: string | undefined;
  /** A new group beside this one with a second view of its active editor (or empty). */
  split(side: Side): void;
  /** A tab (⌥ leaves the original) or explorer files dropped into this strip at an index. */
  dropInStrip(drag: GroupDrag, index: number, copy: boolean): void;
  /** A tab or explorer files dropped on this group's editor: the middle, or an outer third. */
  dropOnEditor(drag: GroupDrag, zone: Side | "center", copy: boolean): void;
  /** Store a tab's view state with the layout (Markdown's Preview or Source choice). */
  setView(path: string, view: ViewState): void;
}

/** What the group's actions need from the editor around them. */
export interface GroupContext {
  layout: EditorLayout;
  change(next: EditorLayout): void;
  newGroupId: NewGroupId;
  /** Paths with unsaved edits now: their last views ask before closing. */
  unsaved(): ReadonlySet<string>;
  /** Tabs left open because closing would lose unsaved text (W5 asks "Save changes?"). */
  confirmClose(refs: readonly TabRef[]): void;
  /** Where a new pane beside `group` goes (see `GroupActions.edge`). */
  edge(group: string, side: Side): Side | undefined;
  /** At the pane cap: why no pane can be made. */
  capped: string | undefined;
}

/** The layout props the editor and Open editors share. */
export interface EditorLayoutProps {
  layout: EditorLayout;
  onLayoutChange(next: EditorLayout): void;
  /** Ids for groups that splits and drops create. */
  newGroupId: NewGroupId;
  buffers: EditorBuffers;
  /** Closing would lose unsaved text in these tabs: ask "Save changes?" (W5's dialog). */
  onConfirmClose?: ((refs: readonly TabRef[]) => void) | undefined;
  /** The most panes this editor holds (4 beside the chat, 9 in full view); unset, the model's. */
  paneCap?: number | undefined;
  /** The widest and tallest the editor area can get now (the panel widening if it can). */
  room?: (() => Room) | undefined;
}

/**
 * The context for one editor's panes. `box` is the editor area's measured size; a new pane on a
 * left or right edge sits beside only while the panes keep 280px each in the most room the
 * editor can get, else it goes below or above (`splitSide`).
 */
export function groupContext(props: EditorLayoutProps, box?: Room): GroupContext {
  const { layout, buffers } = props;
  const cap = props.paneCap ?? limits.groups;
  return {
    capped: groupsOf(layout).length >= cap ? paneCapReason(cap) : undefined,
    edge: (group, side) => {
      if (groupsOf(layout).length >= cap) return undefined;
      const most = props.room?.();
      const room = {
        width: Math.max(box?.width ?? 0, most?.width ?? 0),
        height: Math.max(box?.height ?? 0, most?.height ?? 0),
      };
      return splitSide(layout, group, side, room);
    },
    layout,
    change: props.onLayoutChange,
    newGroupId: props.newGroupId,
    unsaved: () =>
      new Set(
        groupsOf(layout)
          .flatMap((group) => group.tabs.map((tab) => tab.path))
          .filter((path) => buffers.snapshot(path)?.dirty),
      ),
    confirmClose: (refs) => props.onConfirmClose?.(refs),
  };
}

/** Why no more panes can be made at `cap`: the side panel holds fewer than full view. */
export function paneCapReason(cap: number): string {
  return cap < limits.groups
    ? `Up to ${cap} panes beside the chat`
    : `Up to ${cap} panes in full view`;
}

export function bindGroupActions(group: string, context: GroupContext): GroupActions {
  const { layout } = context;
  const run = (next: EditorLayout) => {
    if (next !== layout) context.change(next);
  };
  const close = (refs: readonly TabRef[]) => {
    if (refs.length === 0) return;
    const result = closeTabs(layout, refs, context.unsaved());
    run(result.layout);
    if (result.asking.length > 0) context.confirmClose(result.asking);
  };
  const drop = (drag: GroupDrag, target: DropTarget, copy: boolean) => {
    if (drag.kind === "tab")
      return run((copy ? copyTab : moveTab)(layout, drag.tab, target, context.newGroupId));
    // The first file lands at the target (making its group for an edge); the rest follow it there.
    let next = layout;
    drag.paths.forEach((path, index) => {
      const at: DropTarget =
        index === 0
          ? target
          : target.kind === "strip"
            ? { ...target, index: target.index + index }
            : { kind: "group", group: next.focused };
      next = dropFile(next, path, at, context.newGroupId);
    });
    run(next);
  };
  return {
    focus: () => run(focusGroup(layout, group)),
    activate: (path) => run(activateTab(layout, { group, path })),
    keep: (path) => run(keepTab(layout, { group, path })),
    close: (paths) => close(paths.map((path) => ({ group, path }))),
    closeVariant: (path, which) =>
      close(tabsToClose(layout, { group, path }, which, context.unsaved())),
    setPinned: (path, pinned) => run((pinned ? pinTab : unpinTab)(layout, { group, path })),
    splitTab: (path, side) => {
      const placed = context.edge(group, side);
      if (placed)
        run(
          copyTab(
            layout,
            { group, path },
            { kind: "side", group, side: placed },
            context.newGroupId,
          ),
        );
    },
    split: (side) => {
      const placed = context.edge(group, side);
      if (placed) run(splitGroup(layout, group, placed, context.newGroupId));
    },
    dropInStrip: (drag, index, copy) => drop(drag, { kind: "strip", group, index }, copy),
    edge: (side) => context.edge(group, side),
    capped: context.capped,
    dropOnEditor: (drag, zone, copy) => {
      if (zone === "center") return drop(drag, { kind: "group", group }, copy);
      // A tab dropped on the edge of another pane that already shows its file goes nowhere new:
      // that pane takes focus, so a stray drag never stacks up panes of one file.
      const path = drag.kind === "tab" ? drag.tab.path : drag.paths[0];
      const elsewhere = drag.kind !== "tab" || drag.tab.group !== group;
      const shows = findGroup(layout, group)?.tabs.some((tab) => tab.path === path);
      if (path !== undefined && elsewhere && shows)
        return run(activateTab(layout, { group, path }));
      const side = context.edge(group, zone);
      if (side) drop(drag, { kind: "side", group, side }, copy);
    },
    setView: (path, view) => run(setViewState(layout, { group, path }, view)),
  };
}
