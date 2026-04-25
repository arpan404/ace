import { describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";

import { buildApplicationMenuTemplate } from "./applicationMenu";

describe("buildApplicationMenuTemplate", () => {
  it("replaces the generic File menu with app-specific thread and workspace menus", () => {
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
      "Thread",
      "Workspace",
      "editMenu",
      "View",
      "windowMenu",
      "help",
    ]);
    expect(template.some((item) => item.label === "File")).toBe(false);

    const threadMenu = template.find((item) => item.label === "Thread");
    expect(threadMenu?.submenu).toMatchObject([
      { label: "New Thread" },
      { label: "New Local Thread" },
      { type: "separator" },
      { label: "Toggle Plan Mode" },
    ]);

    const workspaceMenu = template.find((item) => item.label === "Workspace");
    expect(workspaceMenu?.submenu).toMatchObject([
      { label: "General Settings" },
      { label: "Chat Settings" },
      { label: "Editor Settings" },
      { label: "Browser Settings" },
      { type: "separator" },
      { label: "Models" },
      { label: "Providers" },
      { label: "Advanced" },
      { label: "Archived Projects & Threads" },
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

    const threadMenu = template.find((item) => item.label === "Thread");
    const threadItems = threadMenu?.submenu as MenuItemConstructorOptions[];
    threadItems[0]?.click?.(undefined as never, undefined as never, undefined as never);
    threadItems[1]?.click?.(undefined as never, undefined as never, undefined as never);

    const helpMenu = template.find((item) => item.role === "help");
    const helpItems = helpMenu?.submenu as MenuItemConstructorOptions[];
    helpItems[0]?.click?.(undefined as never, undefined as never, undefined as never);
    helpItems[1]?.click?.(undefined as never, undefined as never, undefined as never);

    expect(onMenuAction).toHaveBeenNthCalledWith(1, "new-thread");
    expect(onMenuAction).toHaveBeenNthCalledWith(2, "new-local-thread");
    expect(onMenuAction).toHaveBeenNthCalledWith(3, "open-settings-about");
    expect(onCheckForUpdates).toHaveBeenCalledOnce();
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
