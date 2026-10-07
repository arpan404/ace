import { useHotkey } from "@/lib/hotkeys.ts";
import { keymap, type KeymapId } from "@/lib/keymap.ts";
import { withViewTransition } from "@/lib/motion.ts";
import {
  shownTab,
  type ScopeWorkspace,
  type WorkspaceActions,
  type WorkspaceDefinition,
} from "@/lib/workspace/index.ts";

/** The side panel's shortcuts, bound while a screen with one shows (keymap.ts lists them). */
export function WorkspaceHotkeys(props: {
  workspace: ScopeWorkspace;
  definition: WorkspaceDefinition;
  actions: WorkspaceActions;
}) {
  const { workspace, actions } = props;
  useHotkey(keymap.rightPanel.keys, () => actions.toggle(), { id: "rightPanel" });
  useHotkey(
    keymap.fullView.keys,
    () => withViewTransition(() => actions.setExpanded(!workspace.expanded)),
    { id: "fullView" },
  );
  useHotkey(keymap.newTab.keys, () => actions.newTab(), { id: "newTab" });
  useHotkey(
    keymap.closeTab.keys,
    () => {
      const tab = workspace.open ? shownTab(workspace) : undefined;
      if (tab) void actions.close(tab.key);
    },
    { id: "closeTab" },
  );
  useHotkey(keymap.reopenTab.keys, () => actions.reopen(), { id: "reopenTab" });
  useHotkey(keymap.nextTab.keys, () => workspace.open && actions.cycle(1), { id: "nextTab" });
  useHotkey(keymap.previousTab.keys, () => workspace.open && actions.cycle(-1), {
    id: "previousTab",
  });
  // Bound from first paint: the definition names each tool's shortcut, so they work before the
  // kinds' code has loaded (the action waits for it).
  return Object.entries(props.definition.shortcuts ?? {}).map(([kind, shortcut]) => (
    <KindShortcut key={kind} shortcut={shortcut} onPress={() => actions.shortcut(kind)} />
  ));
}

function KindShortcut(props: { shortcut: KeymapId; onPress(): void }) {
  useHotkey(keymap[props.shortcut].keys, props.onPress, { id: props.shortcut });
  return null;
}
