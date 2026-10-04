import { useHotkey } from "@/lib/hotkeys.ts";
import { keymap, type KeymapId } from "@/lib/keymap.ts";
import { withViewTransition } from "@/lib/motion.ts";
import {
  shownTab,
  type Dock,
  type ScopeWorkspace,
  type WorkspaceActions,
  type WorkspaceDefinition,
} from "@/lib/workspace/index.ts";

/** The dock holding keyboard focus, else the side panel if it shows, else the bottom one. */
function targetDock(workspace: ScopeWorkspace): Dock | undefined {
  const focused = document.activeElement?.closest<HTMLElement>("[data-dock]")?.dataset.dock;
  if (focused === "right" || focused === "bottom") return focused;
  if (workspace.right.open) return "right";
  if (workspace.bottom.open) return "bottom";
  return undefined;
}

/** The workspace's shortcuts, bound while a screen with docks shows (keymap.ts lists them). */
export function WorkspaceHotkeys(props: {
  workspace: ScopeWorkspace;
  definition: WorkspaceDefinition;
  actions: WorkspaceActions;
}) {
  const { workspace, actions } = props;
  useHotkey(keymap.rightPanel.keys, () => actions.toggle("right"));
  useHotkey(keymap.bottomPanel.keys, () => actions.toggle("bottom"));
  useHotkey(keymap.fullView.keys, () =>
    withViewTransition(() => actions.setExpanded(!workspace.expanded)),
  );
  useHotkey(keymap.newTab.keys, () => actions.newTab(targetDock(workspace) ?? "right"));
  useHotkey(keymap.closeTab.keys, () => {
    const dock = targetDock(workspace);
    const tab = dock && shownTab(workspace[dock]);
    if (tab) actions.close(tab.key);
  });
  useHotkey(keymap.nextTab.keys, () => {
    const dock = targetDock(workspace);
    if (dock) actions.cycle(dock, 1);
  });
  useHotkey(keymap.previousTab.keys, () => {
    const dock = targetDock(workspace);
    if (dock) actions.cycle(dock, -1);
  });
  // Bound from first paint: the definition names each tool's shortcut, so they work before the
  // kinds' code has loaded (the action waits for it).
  return Object.entries(props.definition.shortcuts ?? {}).map(([kind, shortcut]) => (
    <KindShortcut key={kind} shortcut={shortcut} onPress={() => actions.toggleKind(kind)} />
  ));
}

function KindShortcut(props: { shortcut: KeymapId; onPress(): void }) {
  useHotkey(keymap[props.shortcut].keys, props.onPress);
  return null;
}
