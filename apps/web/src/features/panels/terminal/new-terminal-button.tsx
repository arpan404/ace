import { PlusIcon } from "@phosphor-icons/react";
import { useEffectEvent } from "react";
import { useHotkey } from "@/lib/hotkeys.ts";
import { keymap } from "@/lib/keymap.ts";
import { useWorkspaceActions, useWorkspaceStore, type Dock } from "@/lib/workspace/index.ts";
import { openNewTerminal } from "./tabs.ts";
import { ToolbarButton } from "./toolbar.tsx";

/**
 * New terminal, in the strip while a terminal or agent shell shows, with its shortcut bound
 * meanwhile. Offline it still opens the tab, which waits for the daemon and says so.
 */
export function NewTerminalButton(props: { scope: string; dock: Dock }) {
  const store = useWorkspaceStore();
  const actions = useWorkspaceActions(props.scope);
  const open = useEffectEvent(() => openNewTerminal(actions, store.get(props.scope), props.dock));
  useHotkey(keymap.newTerminal.keys, () => open());
  return (
    <ToolbarButton
      icon={PlusIcon}
      label="New terminal"
      shortcut="newTerminal"
      onClick={() => open()}
    />
  );
}
