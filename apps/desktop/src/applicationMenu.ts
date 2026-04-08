import type { DesktopMenuAction } from "@ace/contracts";
import type { MenuItemConstructorOptions } from "electron";

interface BuildApplicationMenuOptions {
  readonly appName: string;
  readonly platform: NodeJS.Platform;
  readonly onCheckForUpdates: () => void;
  readonly onMenuAction: (action: DesktopMenuAction) => void;
}

interface MenuActionItemInput {
  readonly action: DesktopMenuAction;
  readonly label: string;
}

function buildMenuActionItem(
  input: MenuActionItemInput,
  onMenuAction: (action: DesktopMenuAction) => void,
): MenuItemConstructorOptions {
  return {
    label: input.label,
    click: () => onMenuAction(input.action),
  };
}

export function buildApplicationMenuTemplate({
  appName,
  platform,
  onCheckForUpdates,
  onMenuAction,
}: BuildApplicationMenuOptions): MenuItemConstructorOptions[] {
  const isMac = platform === "darwin";
  const menuActionItem = (input: MenuActionItemInput) => buildMenuActionItem(input, onMenuAction);
  const settingsItem: MenuItemConstructorOptions = {
    label: "Settings...",
    accelerator: "CmdOrCtrl+,",
    click: () => onMenuAction("open-settings"),
  };

  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      label: appName,
      submenu: [
        { role: "about" },
        {
          label: "Check for Updates...",
          click: () => onCheckForUpdates(),
        },
        { type: "separator" },
        settingsItem,
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  } else {
    template.push({
      label: appName,
      submenu: [settingsItem, { type: "separator" }, { role: "quit" }],
    });
  }

  template.push(
    {
      label: "Thread",
      submenu: [
        menuActionItem({ action: "new-thread", label: "New Thread" }),
        menuActionItem({ action: "new-local-thread", label: "New Local Thread" }),
        { type: "separator" },
        menuActionItem({ action: "toggle-plan-mode", label: "Toggle Plan Mode" }),
      ],
    },
    {
      label: "Workspace",
      submenu: [
        menuActionItem({ action: "open-settings", label: "General Settings" }),
        menuActionItem({ action: "open-settings-chat", label: "Chat Settings" }),
        menuActionItem({ action: "open-settings-editor", label: "Editor Settings" }),
        menuActionItem({ action: "open-settings-browser", label: "Browser Settings" }),
        { type: "separator" },
        menuActionItem({ action: "open-settings-models", label: "Models" }),
        menuActionItem({ action: "open-settings-providers", label: "Providers" }),
        menuActionItem({ action: "open-settings-advanced", label: "Advanced" }),
        menuActionItem({
          action: "open-settings-archived",
          label: "Archived Projects & Threads",
        }),
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        menuActionItem({ action: "toggle-terminal", label: "Toggle Terminal" }),
        menuActionItem({ action: "toggle-browser", label: "Toggle Browser" }),
        menuActionItem({ action: "toggle-diff", label: "Toggle Diff" }),
        { type: "separator" },
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn", accelerator: "CmdOrCtrl+=" },
        { role: "zoomIn", accelerator: "CmdOrCtrl+Plus", visible: false },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        menuActionItem({ action: "open-settings-about", label: "Version & CLI Status" }),
        {
          label: "Check for Updates...",
          click: () => onCheckForUpdates(),
        },
      ],
    },
  );

  return template;
}
