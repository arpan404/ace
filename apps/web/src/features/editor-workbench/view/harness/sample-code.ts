/** Sample text for the harness's stand-in editor. */
export const sampleCode: Record<string, string> = {
  "packages/ui-core/src/workspace-tabs.ts": `import * as z from "zod/mini";

/** Close one resource. Its nearest neighbour takes over. */
export function closeTab(workspace: ScopeWorkspace, key: string) {
  const found = findTab(workspace, key);
  if (!found) return workspace;
  const tabs = workspace.tabs.filter((_, at) => at !== found.index);
  const active =
    workspace.active === key ? neighbour(workspace.tabs, found.index) : workspace.active;
  return patch(workspace, { tabs, active, open: tabs.length > 0 });
}

/** Close every unpinned tab but this one. */
export function closeOtherTabs(workspace: ScopeWorkspace, key: string) {
  if (!findTab(workspace, key)) return workspace;
  const tabs = workspace.tabs.filter((tab) => tab.pinned || tab.key === key);
  return patch(workspace, { tabs, active: key });
}

/** Close the tabs after this one, keeping pinned ones. */
export function closeTabsToTheRight(workspace: ScopeWorkspace, key: string) {
  const found = findTab(workspace, key);
  if (!found) return workspace;
  const tabs = workspace.tabs.filter((tab, at) => tab.pinned || at <= found.index);
  return patch(workspace, { tabs });
}`,
  "apps/web/src/features/editor/editor-groups.ts": `import { closeTab, openTab, type ScopeWorkspace } from "@ace/ui-core";

/** Where a dragged tab lands: a strip position, or a side of a group. */
export type DropTarget =
  | { kind: "strip"; group: string; index: number }
  | { kind: "split"; group: string; side: "left" | "right" };

/** The side of a group a point falls in; the middle third is the group itself. */
export function dropSide(x: number, y: number, box: Box) {
  const fx = (x - box.left) / box.width;
  const fy = (y - box.top) / box.height;
  if (fx > 1 / 3 && fx < 2 / 3 && fy > 1 / 3 && fy < 2 / 3)
    return "split";
}

/** Move a tab into another group; the source closes once empty. */
export function moveToGroup(layout: Layout, key: string, target: DropTarget) {
  const from = groupOf(layout, key);
  if (!from) return layout;
  const tab = tabIn(from, key);
  const left = closeTab(from.tabs, key);
  return prune(replaceGroups(layout, [left]));
}`,
};
