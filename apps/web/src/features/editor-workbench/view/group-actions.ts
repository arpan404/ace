import {
  activateTab,
  closeTabs,
  copyTab,
  focusGroup,
  groupsOf,
  keepTab,
  moveTab,
  pinTab,
  setViewState,
  tabsToClose,
  unpinTab,
  type CloseWhich,
  type DropTarget,
  type EditorLayout,
  type NewGroupId,
  type Side,
  type TabRef,
  type ViewState,
} from "@ace/ui-core/editor-workbench";
import type { EditorBuffers } from "./editor-buffers.ts";
import type { TabDrag } from "./drag.ts";

/** What one group's chrome can do, bound to that group and the layout it was drawn from. */
export interface GroupActions {
  focus(): void;
  activate(path: string): void;
  keep(path: string): void;
  close(paths: readonly string[]): void;
  /** A tab menu's close variant around `path`. */
  closeVariant(path: string, which: CloseWhich): void;
  setPinned(path: string, pinned: boolean): void;
  /** A second view of a tab in a new group on one side of this one. */
  splitTab(path: string, side: Side): void;
  /** A dragged tab dropped into this group's strip at an index; ⌥ leaves the original. */
  dropInStrip(drag: TabDrag, index: number, copy: boolean): void;
  /** A dragged tab dropped on this group's editor: the middle, or an outer third. */
  dropOnEditor(drag: TabDrag, zone: Side | "center", copy: boolean): void;
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
}

export function groupContext(props: EditorLayoutProps): GroupContext {
  const { layout, buffers } = props;
  return {
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
  const drop = (drag: TabDrag, target: DropTarget, copy: boolean) =>
    run((copy ? copyTab : moveTab)(layout, drag, target, context.newGroupId));
  return {
    focus: () => run(focusGroup(layout, group)),
    activate: (path) => run(activateTab(layout, { group, path })),
    keep: (path) => run(keepTab(layout, { group, path })),
    close: (paths) => close(paths.map((path) => ({ group, path }))),
    closeVariant: (path, which) =>
      close(tabsToClose(layout, { group, path }, which, context.unsaved())),
    setPinned: (path, pinned) => run((pinned ? pinTab : unpinTab)(layout, { group, path })),
    splitTab: (path, side) =>
      run(copyTab(layout, { group, path }, { kind: "side", group, side }, context.newGroupId)),
    dropInStrip: (drag, index, copy) => drop(drag, { kind: "strip", group, index }, copy),
    dropOnEditor: (drag, zone, copy) =>
      drop(
        drag,
        zone === "center" ? { kind: "group", group } : { kind: "side", group, side: zone },
        copy,
      ),
    setView: (path, view) => run(setViewState(layout, { group, path }, view)),
  };
}
