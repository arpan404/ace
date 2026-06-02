import { describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";

import { buildApplicationMenuTemplate } from "./applicationMenu";

describe("buildApplicationMenuTemplate", () => {
  it("replaces the generic File menu with app-specific product menus", () => {
    const onCheckForUpdates = vi.fn();
    const onMenuAction = vi.fn();
    const template = buildApplicationMenuTemplate({
      appName: "ace",
      platform: "darwin",
      onCheckForUpdates,
      onMenuAction,
    });

    expect(template.map((item) => item.label ?? item.role)).toEqual([
      "ace",
      "Chat",
      "Agents",
      "Projects",
      "Connections",
      "editMenu",
      "Tools",
      "View",
      "windowMenu",
      "help",
    ]);
    expect(template.some((item) => item.label === "File")).toBe(false);

    const appMenu = template.find((item) => item.label === "ace");
    expect(appMenu?.submenu).toMatchObject([
      { role: "about" },
      { label: "Check for Updates..." },
      { type: "separator" },
      { label: "New Window", accelerator: "CmdOrCtrl+Shift+N" },
    ]);

    const chatMenu = template.find((item) => item.label === "Chat");
    expect(chatMenu?.submenu).toMatchObject([
      { label: "New Thread" },
      { label: "New Local Thread" },
      { type: "separator" },
      { label: "Toggle Plan Mode" },
      { type: "separator" },
      { label: "Chat Settings" },
      { label: "Archived Threads" },
    ]);

    const agentsMenu = template.find((item) => item.label === "Agents");
    expect(agentsMenu?.submenu).toMatchObject([
      { label: "Providers & Auth" },
      { label: "Models" },
      { label: "Agent Behavior" },
      { label: "Advanced Agent Settings" },
    ]);

    const projectsMenu = template.find((item) => item.label === "Projects");
    expect(projectsMenu?.submenu).toMatchObject([
      { label: "General Settings" },
      { label: "Editor & Diff Settings" },
      { label: "Archived Projects & Threads" },
    ]);

    const connectionsMenu = template.find((item) => item.label === "Connections");
    expect(connectionsMenu?.submenu).toMatchObject([
      { label: "Devices & Remote Hosts" },
      { label: "Browser Settings" },
      { label: "Diagnostics & Version" },
      { type: "separator" },
      { label: "Check for Updates..." },
    ]);

    const toolsMenu = template.find((item) => item.label === "Tools");
    expect(toolsMenu?.submenu).toMatchObject([
      { label: "Toggle Terminal" },
      { label: "Open Browser Tab" },
      { label: "Open Review Tab" },
      { type: "separator" },
      { label: "Advanced Settings" },
    ]);
  });

  it("wires menu clicks to the correct desktop actions", () => {
    const onCheckForUpdates = vi.fn();
    const onMenuAction = vi.fn();
    const template = buildApplicationMenuTemplate({
      appName: "ace",
      platform: "linux",
      onCheckForUpdates,
      onMenuAction,
    });

    const chatMenu = template.find((item) => item.label === "Chat");
    const chatItems = chatMenu?.submenu as MenuItemConstructorOptions[];
    chatItems[0]?.click?.(undefined as never, undefined as never, undefined as never);
    chatItems[1]?.click?.(undefined as never, undefined as never, undefined as never);

    const appMenu = template.find((item) => item.label === "ace");
    const appItems = appMenu?.submenu as MenuItemConstructorOptions[];
    appItems[0]?.click?.(undefined as never, undefined as never, undefined as never);

    const connectionsMenu = template.find((item) => item.label === "Connections");
    const connectionItems = connectionsMenu?.submenu as MenuItemConstructorOptions[];
    connectionItems[0]?.click?.(undefined as never, undefined as never, undefined as never);
    connectionItems[4]?.click?.(undefined as never, undefined as never, undefined as never);

    const helpMenu = template.find((item) => item.role === "help");
    const helpItems = helpMenu?.submenu as MenuItemConstructorOptions[];
    helpItems[0]?.click?.(undefined as never, undefined as never, undefined as never);
    helpItems[1]?.click?.(undefined as never, undefined as never, undefined as never);

    expect(onMenuAction).toHaveBeenNthCalledWith(1, "new-thread");
    expect(onMenuAction).toHaveBeenNthCalledWith(2, "new-local-thread");
    expect(onMenuAction).toHaveBeenNthCalledWith(3, "new-window");
    expect(onMenuAction).toHaveBeenNthCalledWith(4, "open-settings-devices");
    expect(onMenuAction).toHaveBeenNthCalledWith(5, "open-settings-about");
    expect(onCheckForUpdates).toHaveBeenCalledTimes(2);
  });

  it("routes zoom shortcuts through app-owned actions instead of Electron global zoom roles", () => {
    const onCheckForUpdates = vi.fn();
    const onMenuAction = vi.fn();
    const template = buildApplicationMenuTemplate({
      appName: "ace",
      platform: "darwin",
      onCheckForUpdates,
      onMenuAction,
    });

    const viewMenu = template.find((item) => item.label === "View");
    const viewItems = viewMenu?.submenu as MenuItemConstructorOptions[];
    expect(viewItems.some((item) => item.role === "zoomIn" || item.role === "zoomOut")).toBe(false);
    expect(viewItems).toContainEqual(
      expect.objectContaining({
        accelerator: "CmdOrCtrl+=",
        label: "Zoom In",
      }),
    );
    expect(viewItems).toContainEqual(
      expect.objectContaining({
        accelerator: "CmdOrCtrl+-",
        label: "Zoom Out",
      }),
    );
  });
});
