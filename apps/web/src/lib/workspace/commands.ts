import { keymap } from "@/lib/keymap.ts";
import { shownTab, type Dock, type ScopeWorkspace } from "./model.ts";
import {
  useFocusedScope,
  useScopeWorkspace,
  useWorkspaceActions,
  useWorkspaceStore,
} from "./react.tsx";

/**
 * A command on the showing tab, for the command palette: the tab menu's actions, reachable
 * without a mouse or a context-menu key (PN-05, PN-19). Shaped like a palette command minus its
 * icon, so the palette can list these as they are.
 */
export interface WorkspaceCommand {
  id: string;
  label: string;
  /** Keymap notation of the shortcut that does the same (follows the user's rebinding). */
  keys?: string;
  /** Why it can't run now. */
  disabled?: string;
  run(): void;
}

/** The dock whose tab the commands act on: the focused one, else the side panel, else the bottom. */
function targetDock(workspace: ScopeWorkspace): Dock | undefined {
  const focused =
    typeof document === "undefined"
      ? undefined
      : document.activeElement?.closest<HTMLElement>("[data-dock]")?.dataset.dock;
  if (focused === "right" || focused === "bottom") return focused;
  if (workspace.right.open && workspace.right.tabs.length) return "right";
  if (workspace.bottom.open && workspace.bottom.tabs.length) return "bottom";
  return undefined;
}

/**
 * The showing tab's commands for the screen in view: move it to the other dock, pin or unpin
 * it, close the others, maximize the bottom panel, and reopen the tab closed last. Empty when no
 * screen with docks shows.
 */
export function useWorkspaceCommands(): readonly WorkspaceCommand[] {
  const scope = useFocusedScope();
  const workspace = useScopeWorkspace(scope);
  return useScopeCommands(scope ?? "", workspace, scope !== undefined);
}

function useScopeCommands(
  scope: string,
  workspace: ScopeWorkspace,
  live: boolean,
): readonly WorkspaceCommand[] {
  // Reads the store's closed-tab memory, which changes without React knowing: never memoized.
  "use no memo";
  const store = useWorkspaceStore();
  const actions = useWorkspaceActions(scope);
  if (!live) return [];
  const definition = store.definition(scope);
  const commands: WorkspaceCommand[] = [];
  const dock = targetDock(workspace);
  const tab = dock && shownTab(workspace[dock]);
  if (dock && tab) {
    const title = definition?.title(tab) ?? tab.title ?? tab.kind;
    const other: Dock = dock === "right" ? "bottom" : "right";
    const movable = definition?.kind(tab.kind)?.docks.includes(other) ?? false;
    if (movable)
      commands.push({
        id: "tab-move",
        label: other === "bottom" ? "Move tab to bottom panel" : "Move tab to side panel",
        run: () => actions.moveToDock(tab.key, other),
      });
    commands.push({
      id: "tab-pin",
      label: tab.pinned ? `Unpin ${title}` : `Pin ${title}`,
      run: () => actions.setPinned(tab.key, !tab.pinned),
    });
    const others = workspace[dock].tabs.filter((each) => !each.pinned && each.key !== tab.key);
    commands.push({
      id: "tab-close-others",
      label: "Close other tabs",
      ...(others.length ? {} : { disabled: "No other tabs to close" }),
      run: () => void actions.closeOthers(tab.key),
    });
  }
  if (workspace.bottom.tabs.length)
    commands.push({
      id: "bottom-maximize",
      label: workspace.bottomMaximized ? "Restore bottom panel" : "Maximize bottom panel",
      run: () => {
        if (!workspace.bottom.open) actions.setOpen("bottom", true);
        actions.setBottomMaximized(!workspace.bottomMaximized);
      },
    });
  commands.push({
    id: "tab-reopen",
    label: "Reopen closed tab",
    keys: keymap.reopenTab.keys,
    ...(store.hasClosed(scope) ? {} : { disabled: "No closed tabs" }),
    run: () => void actions.reopen(),
  });
  return commands;
}
