import { useHotkey } from "@/lib/hotkeys.ts";
import { keymap, type KeymapId } from "@/lib/keymap.ts";
import { withViewTransition } from "@/lib/motion.ts";
import {
  shownTab,
  type ScopeWorkspace,
  type WorkspaceActions,
  type WorkspaceDefinition,
} from "@/lib/workspace/index.ts";
import { focusPanelSoon } from "./panel-focus.ts";

/**
 * The side panel's shortcuts, bound while a screen with one shows (keymap.ts lists them).
 * Opening the panel or showing a tool by shortcut moves focus into the panel; hiding it with
 * focus inside hands focus back (`useFocusBackOnHide`).
 */
export function WorkspaceHotkeys(props: {
  workspace: ScopeWorkspace;
  definition: WorkspaceDefinition;
  actions: WorkspaceActions;
  /** The screen's workspace element, which holds the panel. */
  root(): HTMLElement | null;
}) {
  const { workspace, actions } = props;
  useHotkey(
    keymap.rightPanel.keys,
    () => {
      const opening = !workspace.open;
      actions.toggle();
      if (opening) focusPanelSoon(props.root());
    },
    { id: "rightPanel" },
  );
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
  // kinds' code has loaded (the action waits for it). A tool shown this way takes focus; one
  // hidden by it (already showing) hands focus back as the panel goes.
  return Object.entries(props.definition.shortcuts ?? {}).map(([kind, shortcut]) => (
    <KindShortcut
      key={kind}
      shortcut={shortcut}
      onPress={() => {
        actions.shortcut(kind);
        focusPanelSoon(props.root());
      }}
    />
  ));
}

function KindShortcut(props: { shortcut: KeymapId; onPress(): void }) {
  useHotkey(keymap[props.shortcut].keys, props.onPress, { id: props.shortcut });
  return null;
}
