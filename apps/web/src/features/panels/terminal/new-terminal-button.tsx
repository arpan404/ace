import { useEffectEvent } from "react";
import { useHotkey } from "@/lib/hotkeys.ts";
import { keymap } from "@/lib/keymap.ts";
import { useWorkspaceActions, useWorkspaceStore, type Dock } from "@/lib/workspace/index.ts";
import { openNewTerminal } from "./tabs.ts";

/**
 * ⌃⇧` opens another terminal while a terminal or agent shell shows. The button is the bottom
 * panel's + (`threadWorkspace.plus`); offline it still opens the tab, which waits for the daemon
 * and says so.
 */
export function useNewTerminalHotkey(scope: string, dock: Dock): void {
  const store = useWorkspaceStore();
  const actions = useWorkspaceActions(scope);
  const open = useEffectEvent(() => openNewTerminal(actions, store.get(scope), dock));
  useHotkey(keymap.newTerminal.keys, () => open());
}
