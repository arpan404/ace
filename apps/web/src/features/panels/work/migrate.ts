import type { ScopeWorkspace, WorkspaceTab } from "@/lib/workspace/index.ts";

/** Saved Agents tabs and floating Work details now share the first Work tab. */
export function migrateThreadWorkspace(workspace: ScopeWorkspace): ScopeWorkspace {
  const old = workspace.tabs.find((tab) => tab.kind === "agents");
  const work = workspace.tabs.find((tab) => tab.kind === "work");
  if (!old && work === workspace.tabs[0] && !workspace.workCard?.open) return workspace;
  const first: WorkspaceTab = work ?? {
    key: "work",
    kind: "work",
    id: "work",
    pinned: true,
    ...(old?.ui ? { ui: old.ui } : {}),
  };
  const showingWork = workspace.active === old?.key || workspace.workCard?.open;
  return {
    ...workspace,
    tabs: [first, ...workspace.tabs.filter((tab) => tab.kind !== "agents" && tab.kind !== "work")],
    active: showingWork ? "work" : (workspace.active ?? "work"),
    open: workspace.open || !!workspace.workCard?.open,
    ...(workspace.workCard ? { workCard: { ...workspace.workCard, open: false } } : {}),
  };
}
