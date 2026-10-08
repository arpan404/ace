import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it } from "vitest";
// The web keymap owns every shortcut's behaviour; the menu must replay exactly its chords.
import { keymap } from "../../../web/src/lib/keymap.ts";
import { helpUrl, issuesUrl } from "./links.ts";
import { applicationMenu } from "./menu.ts";
import { acceleratorToKey, shortcuts } from "./shortcuts.ts";

const webKeys = new Map<string, string>(
  Object.entries(keymap).map(([id, entry]) => [id, entry.keys]),
);
const platforms = ["darwin", "win32", "linux"] as const;

/** A web keymap chord as the keys pressed on a platform: "mod+k" is ⌘K on macOS, Ctrl+K elsewhere. */
function pressed(keys: string, platform: NodeJS.Platform): string {
  const parts = keys.split(/\+(?!$)/);
  const key = (parts.pop() ?? "").toLowerCase();
  const modifiers = parts.map((part) =>
    part === "mod"
      ? platform === "darwin"
        ? "meta"
        : "control"
      : part === "ctrl"
        ? "control"
        : part,
  );
  return [...modifiers.toSorted(), key].join("+");
}

/** A replayed key event in the same form. */
function replayed(event: { keyCode: string; modifiers: string[] }): string {
  return [...event.modifiers.toSorted(), event.keyCode.toLowerCase()].join("+");
}

/** Every item of a menu template, submenus included. */
function items(list: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return list.flatMap((entry) => [
    entry,
    ...(Array.isArray(entry.submenu) ? items(entry.submenu) : []),
  ]);
}

/** Builds the menu and records what each choice does. */
function menu(platform: NodeJS.Platform) {
  const effects: string[] = [];
  const template = applicationMenu({
    platform,
    appName: "ace",
    developer: false,
    trigger: (accelerator) =>
      effects.push(`keys:${replayed(acceleratorToKey(accelerator, platform))}`),
    checkForUpdates: () => effects.push("updates"),
    openUrl: (url) => effects.push(`open:${url}`),
    showLogs: () => effects.push("logs"),
  });
  const choose = (entry: MenuItemConstructorOptions | undefined) => {
    if (!entry?.click) throw new Error(`Nothing to choose: ${entry?.label}`);
    Reflect.apply(entry.click, undefined, []);
    return effects.pop();
  };
  const top = (label: string) => {
    const found = template.find((entry) => entry.label === label || entry.role === label);
    return Array.isArray(found?.submenu) ? found.submenu : [];
  };
  return { all: items(template), top, choose };
}

describe("native menu shortcuts", () => {
  it("every shortcut is the chord the web keymap binds to the same action", () => {
    for (const platform of platforms)
      for (const shortcut of shortcuts) {
        const keys = webKeys.get(shortcut.keymapId);
        expect(keys, `${shortcut.keymapId} is not in the web keymap`).toBeDefined();
        expect(
          replayed(acceleratorToKey(shortcut.accelerator, platform)),
          `${shortcut.keymapId} on ${platform}`,
        ).toBe(pressed(keys ?? "", platform));
      }
  });

  it("View › Agents replays the chord that opens Agents, not the terminal", () => {
    for (const platform of platforms) {
      const view = menu(platform);
      const agents = view.top("View").find((entry) => entry.label === "Agents");
      expect(view.choose(agents)).toBe(`keys:${pressed(keymap.agents.keys, platform)}`);
    }
  });

  it("every menu item with a shortcut replays a chord the web binds to that item's action", () => {
    for (const platform of platforms) {
      const built = menu(platform);
      const withKeys = built.all.filter((entry) => entry.accelerator && entry.click);
      expect(withKeys.length).toBeGreaterThan(0);
      for (const entry of withKeys) {
        const shortcut = shortcuts.find((candidate) => candidate.label === entry.label);
        const keys = webKeys.get(shortcut?.keymapId ?? "");
        expect(keys, `${String(entry.label)} has no web shortcut`).toBeDefined();
        expect(built.choose(entry), `${String(entry.label)} on ${platform}`).toBe(
          `keys:${pressed(keys ?? "", platform)}`,
        );
      }
    }
  });

  it("View offers the side panel, full view and find", () => {
    const view = menu("darwin");
    const choices = ["Side Panel", "Full View", "Find"].map((label) =>
      view.choose(view.top("View").find((entry) => entry.label === label)),
    );
    expect(choices).toEqual([
      `keys:${pressed(keymap.rightPanel.keys, "darwin")}`,
      `keys:${pressed(keymap.fullView.keys, "darwin")}`,
      `keys:${pressed(keymap.findInThread.keys, "darwin")}`,
    ]);
  });
});

describe("Help menu", () => {
  it("opens help, the issue tracker and the logs on every platform", () => {
    for (const platform of platforms) {
      const built = menu(platform);
      const help = built.top("help");
      const choose = (label: string) => built.choose(help.find((entry) => entry.label === label));
      expect(choose("ace Help")).toBe(`open:${helpUrl}`);
      expect(choose("Report an Issue…")).toBe(`open:${issuesUrl}`);
      expect(choose("Show Logs")).toBe("logs");
    }
  });

  it("Windows and Linux find About and updates under Help; macOS in the app menu", () => {
    for (const platform of ["win32", "linux"] as const) {
      const built = menu(platform);
      const help = built.top("help");
      expect(help.some((entry) => entry.role === "about")).toBe(true);
      expect(built.choose(help.find((entry) => entry.label === "Check for Updates…"))).toBe(
        "updates",
      );
    }
    const mac = menu("darwin");
    const appMenu = mac.top("ace");
    expect(appMenu.some((entry) => entry.role === "about")).toBe(true);
    expect(mac.choose(appMenu.find((entry) => entry.label === "Check for Updates…"))).toBe(
      "updates",
    );
  });
});
