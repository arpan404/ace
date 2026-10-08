import type { MenuItemConstructorOptions } from "electron";
import { helpUrl, issuesUrl } from "./links.ts";
import { shortcuts } from "./shortcuts.ts";

/**
 * Menu items show the shortcut but do not capture it (`registerAccelerator: false`): the key
 * still reaches the page, where the web keymap handles it, including while typing. Choosing
 * the item with the mouse replays the same chord into the page through `trigger`.
 */
export function applicationMenu(options: {
  platform: NodeJS.Platform;
  appName: string;
  /** Developer tools are for development builds only. */
  developer: boolean;
  trigger(accelerator: string): void;
  checkForUpdates(): void;
  openUrl(url: string): void;
  showLogs(): void;
}): MenuItemConstructorOptions[] {
  const mac = options.platform === "darwin";
  const item = (keymapId: string): MenuItemConstructorOptions => {
    const shortcut = shortcuts.find((entry) => entry.keymapId === keymapId);
    if (!shortcut?.label) throw new Error(`No menu shortcut for ${keymapId}`);
    const { accelerator } = shortcut;
    return {
      label: shortcut.label,
      accelerator,
      registerAccelerator: false,
      click: () => options.trigger(accelerator),
    };
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
        item("palette"),
        item("search"),
        item("findInThread"),
        { type: "separator" },
        item("toggleSidebar"),
        item("rightPanel"),
        item("fullView"),
        { type: "separator" },
        item("agents"),
        item("changes"),
        item("terminal"),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
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
