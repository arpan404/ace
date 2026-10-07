import { useEffectEvent } from "react";
import { useHotkey } from "@/lib/hotkeys.ts";
import { keymap } from "@/lib/keymap.ts";
import { useWorkspaceActions, useWorkspaceStore } from "@/lib/workspace/index.ts";
import { openNewTerminal } from "./tabs.ts";

/**
 * ⌃⇧` opens another terminal while a terminal or agent shell shows (the sessions menu's New
 * terminal); offline it still opens the tab, which waits for the daemon and says so.
 */
export function useNewTerminalHotkey(scope: string): void {
  const store = useWorkspaceStore();
  const actions = useWorkspaceActions(scope);
  const open = useEffectEvent(() => openNewTerminal(actions, store.get(scope)));
  useHotkey(keymap.newTerminal.keys, () => open(), { id: "newTerminal" });
}
