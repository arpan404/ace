import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { DesktopSettings } from "../../shared/contract.ts";
import { linuxAutostart, nodeAutostartFiles } from "./autostart.ts";
import { settingsEffects } from "./settings-effects.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const root = mkdtempSync(join(tmpdir(), "ace-autostart-"));
  roots.push(root);
  return root;
}

function loginItem(options: { home: string; env?: Record<string, string>; execPath?: string }) {
  const warnings: string[] = [];
  const item = linuxAutostart({
    env: options.env ?? {},
    home: options.home,
    execPath: options.execPath ?? "/opt/ace/ace",
    appId: "dev.ace.app",
    files: nodeAutostartFiles,
    warn: (message) => warnings.push(message),
  });
  return { item, warnings };
}

function applyWith(item: ReturnType<typeof loginItem>["item"]) {
  return settingsEffects({
    loginItem: item,
    shortcuts: { register: () => true, unregister() {} },
    warn() {},
  });
}

function execLine(path: string): string | undefined {
  return readFileSync(path, "utf8")
    .split("\n")
    .find((line) => line.startsWith("Exec="));
}

test("turning Open at login on and off adds and removes an entry that starts ace in the background", () => {
  const root = home();
  const { item } = loginItem({ home: root });
  const apply = applyWith(item);
  const entry = join(root, ".config", "autostart", "dev.ace.app.desktop");

  apply(DesktopSettings.parse({ openAtLogin: true }));
  expect(readFileSync(entry, "utf8")).toMatch(/^\[Desktop Entry\]\nType=Application\n/);
  expect(execLine(entry)).toBe("Exec=/opt/ace/ace --background");
  expect(item.enabled()).toBe(true);

  apply(DesktopSettings.parse({ openAtLogin: false }));
  expect(existsSync(entry)).toBe(false);
  expect(item.enabled()).toBe(false);
});

test("the entry goes in XDG_CONFIG_HOME only when it is an absolute path", () => {
  const root = home();
  const config = join(root, "custom-config");
  loginItem({ home: root, env: { XDG_CONFIG_HOME: config } }).item.setEnabled(true);
  expect(existsSync(join(config, "autostart", "dev.ace.app.desktop"))).toBe(true);

  loginItem({ home: root, env: { XDG_CONFIG_HOME: "relative/config" } }).item.setEnabled(true);
  expect(existsSync(join(root, ".config", "autostart", "dev.ace.app.desktop"))).toBe(true);
});

test("under an AppImage the entry starts the AppImage file, not its temporary mount", () => {
  const root = home();
  const { item } = loginItem({
    home: root,
    env: { APPIMAGE: "/home/me/Apps/ace.AppImage" },
    execPath: "/tmp/.mount_aceXYZ/ace",
  });
  item.setEnabled(true);
  expect(execLine(join(root, ".config", "autostart", "dev.ace.app.desktop"))).toBe(
    "Exec=/home/me/Apps/ace.AppImage --background",
  );
});

test("from a tar.gz the entry starts its launcher, which works where the sandbox is blocked", () => {
  const root = home();
  const { item } = loginItem({ home: root, execPath: "/home/me/ace-1.0.0-x64/ace-desktop-bin" });
  item.setEnabled(true);
  expect(execLine(join(root, ".config", "autostart", "dev.ace.app.desktop"))).toBe(
    "Exec=/home/me/ace-1.0.0-x64/ace-desktop --background",
  );
});

test("an entry left by an AppImage that has since moved is rewritten with the new path", () => {
  const root = home();
  const entry = join(root, ".config", "autostart", "dev.ace.app.desktop");
  loginItem({ home: root, env: { APPIMAGE: "/old/ace.AppImage" } }).item.setEnabled(true);
  const { item } = loginItem({ home: root, env: { APPIMAGE: "/new/ace.AppImage" } });
  expect(item.enabled()).toBe(false);

  applyWith(item)(DesktopSettings.parse({ openAtLogin: true }));
  expect(execLine(entry)).toBe("Exec=/new/ace.AppImage --background");
});

// xdg-open's generic mode (bare window managers, Hyprland, Sway) runs Exec's first word as
// written, quotes included, so only a path that needs quoting gets them.
test("a plain path is written bare and a percent sign still can't read as a field code", () => {
  const root = home();
  loginItem({ home: root, execPath: "/opt/ace-100%/ace" }).item.setEnabled(true);
  expect(execLine(join(root, ".config", "autostart", "dev.ace.app.desktop"))).toBe(
    "Exec=/opt/ace-100%%/ace --background",
  );
});

test("paths with spaces, quotes, dollars, backslashes and percent signs survive Exec quoting", () => {
  const root = home();
  loginItem({ home: root, execPath: '/opt/my "ace" $HOME 100%\\x/ace' }).item.setEnabled(true);
  expect(execLine(join(root, ".config", "autostart", "dev.ace.app.desktop"))).toBe(
    'Exec="/opt/my \\\\"ace\\\\" \\\\$HOME 100%%\\\\\\\\x/ace" --background',
  );
});

test("a login entry that can't be written is reported, not thrown", () => {
  const root = home();
  // A file where the config folder should be makes the write fail.
  writeFileSync(join(root, "config-file"), "");
  const { item, warnings } = loginItem({
    home: root,
    env: { XDG_CONFIG_HOME: join(root, "config-file") },
  });
  expect(() => item.setEnabled(true)).not.toThrow();
  expect(item.enabled()).toBe(false);
  expect(warnings).toHaveLength(1);
});
