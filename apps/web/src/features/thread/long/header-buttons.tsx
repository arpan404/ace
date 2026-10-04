import { ChatCircleTextIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useHotkey } from "@/lib/hotkeys.ts";
import { keymap } from "@/lib/keymap.ts";
import { useThreadNav } from "./nav.tsx";

/**
 * The header's ways into a long thread: search it (⌘F) and its turns (⌥⌘G). Their shortcuts
 * are bound here, with the thread screen, so they work before the tools' code has loaded.
 */
export function LongThreadButtons() {
  const nav = useThreadNav();
  const find = () => {
    nav.setSearchOpen(true);
    nav.searchFocus.set(nav.searchFocus.get() + 1);
  };
  useHotkey(keymap.findInThread.keys, find);
  useHotkey(keymap.turns.keys, () => nav.setTurnsOpen(!nav.turnsOpen));
  return (
    <>
      <IconButton
        icon={MagnifyingGlassIcon}
        label="Search this thread"
        shortcut="findInThread"
        pressed={nav.searchOpen}
        onClick={() => (nav.searchOpen ? nav.setSearchOpen(false) : find())}
      />
      <IconButton
        icon={ChatCircleTextIcon}
        label="Turns"
        shortcut="turns"
        pressed={nav.turnsOpen}
        onClick={() => nav.setTurnsOpen(!nav.turnsOpen)}
      />
    </>
  );
}
