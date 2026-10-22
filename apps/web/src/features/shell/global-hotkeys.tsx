import { useNavigate } from "@tanstack/react-router";
import { reloadApp } from "@/boot/desktop.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { isEditable, useHotkey } from "@/lib/hotkeys.ts";
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
  /** ⌘N, composed in by the app layer: asks which project when there are several. */
  onNewThread?(): void;
  /** ⇧⌘N: a new thread in the current project, without asking. */
  onNewThreadHere?(): void;
}) {
  useKeybindingsSync();
  const navigate = useNavigate();
  const nav = useHistoryNav();
  const layout = useLayout();
  const noProjects = useNoProjects() && props.onAddProject !== undefined;
  useHotkey(keymap.shortcuts.keys, () => layout.setShortcutsOpen(!layout.shortcutsOpen));
  // ⌘K and ⇧⌘K: the one launcher (search, threads and commands).
  useHotkey(keymap.palette.keys, () => layout.setPaletteOpen(!layout.paletteOpen));
  useHotkey(keymap.newThread.keys, () =>
    props.onNewThread
      ? props.onNewThread()
      : noProjects
        ? props.onAddProject?.()
        : void navigate({ to: "/new" }),
  );
  useHotkey(keymap.newThreadHere.keys, () =>
    props.onNewThreadHere ? props.onNewThreadHere() : void navigate({ to: "/new" }),
  );
  useHotkey(keymap.back.keys, nav.back);
  useHotkey(keymap.forward.keys, nav.forward);
  useHotkey(keymap.settings.keys, () => void navigate({ to: "/settings" }));
  // A focused browser panel handles ⌘R first and reloads its own page instead.
  useHotkey(keymap.reloadApp.keys, () => reloadApp());
  useHotkey(keymap.goHome.keys, () => void navigate({ to: "/" }));
  useHotkey(keymap.goAutomations.keys, () => void navigate({ to: "/automations" }));
  useHotkey(keymap.goSkills.keys, () => void navigate({ to: "/skills" }));
  useHotkey(keymap.goPullRequests.keys, () => void navigate({ to: "/pulls" }));
  useHotkey(keymap.goIssues.keys, () => void navigate({ to: "/issues" }));
  // ⌘. stops the showing thread's agent tree from anywhere in it, as the composer's Stop does.
  const stop = layout.composerActions?.stop;
  useHotkey(keymap.stopAgent.keys, () => stop?.(), { id: "stopAgent", enabled: !!stop });
  // ⌘Z takes back the latest list action while its Undo shows; a text field keeps its own.
  const toast = useToast();
  useHotkey(keymap.undo.keys, () => toast.undoLatest(), {
    when: (event) => !isEditable(event.target),
  });
  return null;
}
