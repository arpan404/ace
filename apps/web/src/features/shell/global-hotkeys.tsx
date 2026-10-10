import { useNavigate } from "@tanstack/react-router";
import { useHotkey } from "@/lib/hotkeys.ts";
import { useKeybindingsSync } from "@/lib/keybindings.ts";
import { useHistoryNav } from "@/lib/history-nav.ts";
import { keymap } from "@/lib/keymap.ts";
import { useLayout } from "@/lib/layout.tsx";
import { useNoProjects } from "./app-sidebar.tsx";

/**
 * App-wide shortcuts. Panel tab shortcuts are bound by the screens that have those panels.
 * Also keeps every binding in step with the user's rebindings (Settings › Keyboard).
 */
export function GlobalHotkeys(props: {
  /** Opens Add project; composed in by the app layer. New thread does this while there is none. */
  onAddProject?(): void;
}) {
  useKeybindingsSync();
  const navigate = useNavigate();
  const nav = useHistoryNav();
  const layout = useLayout();
  const noProjects = useNoProjects() && props.onAddProject !== undefined;
  useHotkey(keymap.shortcuts.keys, () => layout.setShortcutsOpen(!layout.shortcutsOpen));
  useHotkey(keymap.palette.keys, () => layout.setPaletteOpen(!layout.paletteOpen));
  useHotkey(keymap.search.keys, () => (layout.search ? layout.closeSearch() : layout.openSearch()));
  useHotkey(keymap.newThread.keys, () =>
    noProjects ? props.onAddProject?.() : void navigate({ to: "/new" }),
  );
  useHotkey(keymap.back.keys, nav.back);
  useHotkey(keymap.forward.keys, nav.forward);
  useHotkey(keymap.settings.keys, () => void navigate({ to: "/settings" }));
  useHotkey(keymap.goHome.keys, () => void navigate({ to: "/" }));
  useHotkey(keymap.goActivity.keys, () => void navigate({ to: "/activity" }));
  useHotkey(keymap.goAutomations.keys, () => void navigate({ to: "/automations" }));
  useHotkey(keymap.goSkills.keys, () => void navigate({ to: "/skills" }));
  return null;
}
