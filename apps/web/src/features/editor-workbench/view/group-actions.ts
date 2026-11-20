import type { TabDrag } from "./drag.ts";
import type { DeckLayout, DeckOps, SplitSide } from "./layout.ts";

/** What one group's chrome can do, bound to that group. */
export interface GroupActions {
  focus(): void;
  activate(path: string): void;
  keep(path: string): void;
  close(paths: readonly string[]): void;
  setPinned(path: string, pinned: boolean): void;
  /** Split a tab of this group to one of its sides (a second view: the original stays). */
  splitTab(path: string, side: SplitSide): void;
  /** A dragged tab dropped into this group's strip, at an index. */
  dropInStrip(drag: TabDrag, index: number): void;
  /** A dragged tab dropped on this group's editor: the middle, or an outer third. */
  dropOnEditor(drag: TabDrag, zone: SplitSide | "center", copy: boolean): void;
}

export function bindGroupActions(
  group: string,
  layout: DeckLayout,
  ops: DeckOps,
  change: (next: DeckLayout) => void,
): GroupActions {
  const run = (next: DeckLayout) => {
    if (next !== layout) change(next);
  };
  return {
    focus: () => {
      if (layout.focused !== group) run(ops.focus(layout, group));
    },
    activate: (path) => run(ops.activate(layout, group, path)),
    keep: (path) => run(ops.keep(layout, group, path)),
    close: (paths) => run(ops.close(layout, group, paths)),
    setPinned: (path, pinned) => run(ops.setPinned(layout, group, path, pinned)),
    splitTab: (path, side) => run(ops.split(layout, { group, path }, group, side, true)),
    dropInStrip: (drag, index) => run(ops.move(layout, drag, { group, index })),
    dropOnEditor: (drag, zone, copy) => {
      if (zone !== "center") {
        run(ops.split(layout, drag, group, zone, copy));
        return;
      }
      if (drag.group === group) return;
      run(ops.move(layout, drag, { group, index: Number.MAX_SAFE_INTEGER }));
    },
  };
}
