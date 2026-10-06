import type { ScopeWorkspace, WorkspaceDefinition } from "@/lib/workspace/index.ts";

export const countButton =
  "focus-ring inline-flex h-[30px] min-w-[30px] items-center justify-center rounded-md px-1.5 text-muted-foreground transition-colors duration-(--dur-1) hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground";

/**
 * The side panel's tabs the header counts: not the pinned per-thread tools every thread has
 * (Changes, Agents), so the number says what you opened. Read from the definition, which is
 * there before the kinds load.
 */
export function countedTabs(workspace: ScopeWorkspace, definition: WorkspaceDefinition) {
  const tools = new Set(
    definition.initial.filter((tab) => tab.pinned && tab.dock === "right").map((tab) => tab.kind),
  );
  return workspace.right.tabs.filter((tab) => !(tab.pinned && tools.has(tab.kind)));
}

/** "Open tabs: Changes, Agents, Preview": the count button's name lists every tab. */
export function openTabsLabel(workspace: ScopeWorkspace, definition: WorkspaceDefinition) {
  const title = (tab: ScopeWorkspace["right"]["tabs"][number]) =>
    definition.loaded() ? definition.title(tab) : (tab.title ?? tab.kind);
  return `Open tabs: ${workspace.right.tabs.map(title).join(", ")}`;
}

/** The count itself: a small outlined numeral, like a stack of tabs. */
export function CountMark(props: { count: number }) {
  return (
    <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-xs px-1 text-xs leading-none font-semibold tabular-nums shadow-[inset_0_0_0_1.5px_currentColor]">
      {props.count}
    </span>
  );
}
