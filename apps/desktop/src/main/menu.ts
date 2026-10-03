import type { MenuItemConstructorOptions } from "electron";
import type { MenuCommand } from "../shared/channels.ts";

/** A shortcut from the web keymap (`apps/web/src/lib/keymap.ts`) and its Electron accelerator. */
interface Shortcut {
  command: MenuCommand;
  label: string;
  accelerator: string;
}

/** Kept in step with the web keymap; the web app owns the behaviour, the menu shows it. */
export const shortcuts: readonly Shortcut[] = [
  { command: "new-thread", label: "New Thread", accelerator: "CmdOrCtrl+N" },
  { command: "new-deck", label: "New Deck", accelerator: "CmdOrCtrl+Shift+N" },
  { command: "palette", label: "Command Palette…", accelerator: "CmdOrCtrl+K" },
  { command: "back", label: "Back", accelerator: "CmdOrCtrl+[" },
  { command: "forward", label: "Forward", accelerator: "CmdOrCtrl+]" },
  { command: "toggle-sidebar", label: "Toggle Sidebar", accelerator: "CmdOrCtrl+\\" },
  { command: "agents", label: "Agents", accelerator: "CmdOrCtrl+J" },
  { command: "changes", label: "Changes", accelerator: "CmdOrCtrl+Shift+D" },
  { command: "bottom-panel", label: "Terminal", accelerator: "Ctrl+`" },
  { command: "settings", label: "Settings…", accelerator: "CmdOrCtrl+," },
];

/**
 * Menu items show the shortcut but do not capture it (`registerAccelerator: false`): the key
 * still reaches the page, where the web keymap handles it, including while typing. Choosing
 * the item with the mouse replays the same chord into the page through `trigger`.
 */
export function applicationMenu(options: {
  platform: NodeJS.Platform;
  appName: string;
  trigger(command: MenuCommand, accelerator: string): void;
  checkForUpdates(): void;
}): MenuItemConstructorOptions[] {
  const mac = options.platform === "darwin";
  const item = (command: MenuCommand): MenuItemConstructorOptions => {
    const shortcut = shortcuts.find((entry) => entry.command === command);
    if (!shortcut) throw new Error(`No shortcut for ${command}`);
    return {
      label: shortcut.label,
      accelerator: shortcut.accelerator,
      registerAccelerator: false,
      click: () => options.trigger(command, shortcut.accelerator),
    };
  };
  const appMenu: MenuItemConstructorOptions[] = mac
    ? [
        {
          label: options.appName,
          submenu: [
            { role: "about" },
            { label: "Check for Updates…", click: options.checkForUpdates },
            { type: "separator" },
            item("settings"),
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
      ]
    : [];
  return [
    ...appMenu,
    {
      label: "File",
      submenu: [
        item("new-thread"),
        item("new-deck"),
        { type: "separator" },
        ...(mac ? [{ role: "close" } as const] : [item("settings"), { role: "quit" } as const]),
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        item("palette"),
        { type: "separator" },
        item("toggle-sidebar"),
        item("agents"),
        item("changes"),
        item("bottom-panel"),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "toggleDevTools" },
      ],
    },
    { label: "Go", submenu: [item("back"), item("forward")] },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: mac ? [] : [{ label: "Check for Updates…", click: options.checkForUpdates }],
    },
  ];
}

/** `CmdOrCtrl+Shift+D` → the key event Electron's `sendInputEvent` replays. */
export function acceleratorToKey(
  accelerator: string,
  platform: NodeJS.Platform,
): { keyCode: string; modifiers: ("meta" | "control" | "shift" | "alt")[] } {
  const parts = accelerator.split("+");
  const keyCode = parts.pop() ?? "";
  const modifiers = parts.map((part) => {
    if (part === "CmdOrCtrl") return platform === "darwin" ? "meta" : "control";
    if (part === "Ctrl") return "control";
    if (part === "Shift") return "shift";
    return "alt";
  }) satisfies ("meta" | "control" | "shift" | "alt")[];
  return { keyCode, modifiers };
}
