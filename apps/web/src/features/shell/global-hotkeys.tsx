import { useNavigate } from "@tanstack/react-router";
import { useHotkey } from "@/lib/hotkeys.ts";
import { useHistoryNav } from "@/lib/history-nav.ts";
import { keymap } from "@/lib/keymap.ts";
import { useLayout } from "@/lib/layout.tsx";

/** App-wide shortcuts. Panel tab shortcuts are bound by the screens that have those panels. */
export function GlobalHotkeys() {
  const navigate = useNavigate();
  const nav = useHistoryNav();
  const layout = useLayout();
  useHotkey(keymap.palette.keys, () => layout.setPaletteOpen(!layout.paletteOpen));
  useHotkey(keymap.newThread.keys, () => void navigate({ to: "/new" }));
  useHotkey(keymap.newDeck.keys, () => void navigate({ to: "/deck/new" }));
  useHotkey(keymap.back.keys, nav.back);
  useHotkey(keymap.forward.keys, nav.forward);
  useHotkey(keymap.settings.keys, () => void navigate({ to: "/settings" }));
  useHotkey(keymap.goHome.keys, () => void navigate({ to: "/" }));
  useHotkey(keymap.goActivity.keys, () => void navigate({ to: "/activity" }));
  useHotkey(keymap.goDeck.keys, () => void navigate({ to: "/deck" }));
  useHotkey(keymap.goAutomations.keys, () => void navigate({ to: "/automations" }));
  useHotkey(keymap.goSkills.keys, () => void navigate({ to: "/skills" }));
  return null;
}
