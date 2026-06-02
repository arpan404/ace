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
  const newWindowItem: MenuItemConstructorOptions = {
    label: "New Window",
    accelerator: "CmdOrCtrl+Shift+N",
    click: () => onMenuAction("new-window"),
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
        newWindowItem,
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
      submenu: [
        newWindowItem,
        { type: "separator" },
        settingsItem,
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  template.push(
    {
      label: "Chat",
      submenu: [
        menuActionItem({ action: "new-thread", label: "New Thread" }),
        menuActionItem({ action: "new-local-thread", label: "New Local Thread" }),
        { type: "separator" },
        menuActionItem({ action: "toggle-plan-mode", label: "Toggle Plan Mode" }),
        { type: "separator" },
        menuActionItem({ action: "open-settings-chat", label: "Chat Settings" }),
        menuActionItem({
          action: "open-settings-archived",
          label: "Archived Threads",
        }),
      ],
    },
    {
      label: "Agents",
      submenu: [
        menuActionItem({ action: "open-settings-providers", label: "Providers & Auth" }),
        menuActionItem({ action: "open-settings-models", label: "Models" }),
        menuActionItem({ action: "open-settings-chat", label: "Agent Behavior" }),
        menuActionItem({ action: "open-settings-advanced", label: "Advanced Agent Settings" }),
      ],
    },
    {
      label: "Projects",
      submenu: [
        menuActionItem({ action: "open-settings", label: "General Settings" }),
        menuActionItem({ action: "open-settings-editor", label: "Editor & Diff Settings" }),
        menuActionItem({
          action: "open-settings-archived",
          label: "Archived Projects & Threads",
        }),
      ],
    },
    {
      label: "Connections",
      submenu: [
        menuActionItem({ action: "open-settings-devices", label: "Devices & Remote Hosts" }),
        menuActionItem({ action: "open-settings-browser", label: "Browser Settings" }),
        menuActionItem({ action: "open-settings-about", label: "Diagnostics & Version" }),
        { type: "separator" },
        {
          label: "Check for Updates...",
          click: () => onCheckForUpdates(),
        },
      ],
    },
    { role: "editMenu" },
    {
      label: "Tools",
      submenu: [
        menuActionItem({ action: "toggle-terminal", label: "Toggle Terminal" }),
        menuActionItem({ action: "open-browser-tab", label: "Open Browser Tab" }),
        menuActionItem({ action: "open-review-tab", label: "Open Review Tab" }),
        { type: "separator" },
        menuActionItem({ action: "open-settings-advanced", label: "Advanced Settings" }),
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        {
          ...menuActionItem({ action: "zoom-reset", label: "Actual Size" }),
          accelerator: "CmdOrCtrl+0",
        },
        {
          ...menuActionItem({ action: "zoom-in", label: "Zoom In" }),
          accelerator: "CmdOrCtrl+=",
        },
        {
          ...menuActionItem({ action: "zoom-in", label: "Zoom In" }),
          accelerator: "CmdOrCtrl+Plus",
          visible: false,
        },
        {
          ...menuActionItem({ action: "zoom-out", label: "Zoom Out" }),
          accelerator: "CmdOrCtrl+-",
        },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        menuActionItem({ action: "open-settings-about", label: "Diagnostics & Version" }),
        {
          label: "Check for Updates...",
          click: () => onCheckForUpdates(),
        },
      ],
    },
  );

  return template;
}
