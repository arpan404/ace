import type { MenuItemConstructorOptions } from "electron";
import { helpUrl, issuesUrl } from "./links.ts";
import { keymapAccelerator, shortcuts } from "./shortcuts.ts";
import type { ZoomChange } from "./window/zoom.ts";

/**
 * Menu items show the shortcut but do not capture it (`registerAccelerator: false`): the key
 * still reaches the page, where the web keymap handles it, including while typing. Choosing
 * the item with the mouse dispatches its keymap id through `trigger`.
 */
export function applicationMenu(options: {
  platform: NodeJS.Platform;
  appName: string;
  /** Developer tools are for development builds only. */
  developer: boolean;
  trigger(keymapId: string): void;
  bindings?: Readonly<Record<string, string>> | undefined;
  checkForUpdates(): void;
  openUrl(url: string): void;
  showLogs(): void;
  /** View › Zoom: the focused window's own page, whichever page inside it has focus. */
  zoom(change: ZoomChange): void;
  /** View › Reload: a fresh page and a fresh daemon connection. */
  reload(): void;
}): MenuItemConstructorOptions[] {
  const mac = options.platform === "darwin";
  const item = (keymapId: string): MenuItemConstructorOptions => {
    const shortcut = shortcuts.find((entry) => entry.keymapId === keymapId);
    if (!shortcut?.label) throw new Error(`No menu shortcut for ${keymapId}`);
    const bound = options.bindings?.[keymapId];
    const accelerator = bound === undefined ? shortcut.accelerator : keymapAccelerator(bound);
    return {
      label: shortcut.label,
      ...(accelerator ? { accelerator } : {}),
      registerAccelerator: false,
      click: () => options.trigger(keymapId),
    };
  };
  // Registered, unlike the keymap's items: zoom is the window's, so it must win over a focused
  // visualization. The native browser page keeps ⌘+ for its own zoom (`pageChord`).
  const zoom = (
    label: string,
    change: ZoomChange,
    accelerator: string,
    hidden = false,
  ): MenuItemConstructorOptions => ({
    label,
    accelerator,
    ...(hidden ? { visible: false, acceleratorWorksWhenHidden: true } : {}),
    click: () => options.zoom(change),
  });
  // The click reloads from the main process, so it works even when the page is stuck. The key
  // goes to the page first: a focused browser panel keeps ⌘R for its own page.
  const reload: MenuItemConstructorOptions = {
    ...item("reloadApp"),
    click: () => options.reload(),
  };
  const checkForUpdates: MenuItemConstructorOptions = {
    label: "Check for Updates…",
    click: () => options.checkForUpdates(),
  };
  const appMenu: MenuItemConstructorOptions[] = mac
    ? [
        {
          label: options.appName,
          submenu: [
            { role: "about" },
            checkForUpdates,
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
        item("newThread"),
        { type: "separator" },
        item("addProject"),
        { type: "separator" },
        ...(mac ? [{ role: "close" } as const] : [item("settings"), { role: "quit" } as const]),
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        reload,
        { type: "separator" },
        item("palette"),
        item("findInThread"),
        { type: "separator" },
        item("toggleSidebar"),
        item("rightPanel"),
        item("fullView"),
        { type: "separator" },
        item("agents"),
        item("changes"),
        item("terminal"),
        item("terminalPanel"),
        { type: "separator" },
        zoom("Actual Size", "reset", "CmdOrCtrl+0"),
        zoom("Zoom In", "in", "CmdOrCtrl+Plus"),
        // ⌘= is the key people press for zoom in; ⌘+ needs Shift on most layouts.
        zoom("Zoom In", "in", "CmdOrCtrl+=", true),
        zoom("Zoom Out", "out", "CmdOrCtrl+-"),
        // macOS adds its own Enter Full Screen item (fn F) to the View menu.
        ...(mac ? [] : [{ type: "separator" } as const, { role: "togglefullscreen" } as const]),
        ...(options.developer ? [{ role: "toggleDevTools" } as const] : []),
      ],
    },
    { label: "Go", submenu: [item("back"), item("forward")] },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: `${options.appName} Help`, click: () => options.openUrl(helpUrl) },
        { label: "Report an Issue…", click: () => options.openUrl(issuesUrl) },
        { label: "Show Logs", click: () => options.showLogs() },
        // macOS keeps About and updates in the app menu.
        ...(mac
          ? []
          : [
              { type: "separator" } as const,
              checkForUpdates,
              { role: "about", label: `About ${options.appName}` } as const,
            ]),
      ],
    },
  ];
}
