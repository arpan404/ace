import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createBridge, type BridgeIpc } from "../preload/bridge.ts";
import { requestChannel, requests } from "../shared/channels.ts";
import type { DesktopSettings, DesktopSettingsPatch } from "../shared/contract.ts";
import { settingsEffects } from "./os/settings-effects.ts";
import { SettingsStore } from "./settings-store.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ace-desktop-settings-"));
  roots.push(path);
  return path;
}

test("saved settings survive a restart", async () => {
  const path = join(await root(), "nested", "settings.json");
  const store = new SettingsStore(path);
  await store.update({ openAtLogin: true });
  await store.update({
    preventSleep: true,
    background: false,
    attention: false,
    globalShortcut: "CommandOrControl+Shift+N",
  });
  expect(new SettingsStore(path).get()).toMatchObject({
    openAtLogin: true,
    preventSleep: true,
    background: false,
    attention: false,
    globalShortcut: "CommandOrControl+Shift+N",
  });
});

test("a failed save changes nothing, and later saves still reach the disk", async () => {
  const dir = await root();
  // A file where the settings directory should be: creating the directory fails.
  const blocker = join(dir, "userData");
  await writeFile(blocker, "");
  const path = join(blocker, "settings.json");
  const store = new SettingsStore(path);
  const heard: boolean[] = [];
  store.onChange((settings) => heard.push(settings.openAtLogin));

  await expect(store.update({ openAtLogin: true })).rejects.toThrow();
  expect(store.get().openAtLogin).toBe(false);
  expect(heard).toEqual([]);

  await rm(blocker);
  await store.update({ preventSleep: true });
  expect(store.get()).toMatchObject({ openAtLogin: false, preventSleep: true });
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
    openAtLogin: false,
    preventSleep: true,
  });
  expect(heard).toEqual([false]);
});

/** The page's `window.ace.settings`, over a main process that parses requests as Electron's does. */
function settingsPage(store: SettingsStore) {
  const ipc: BridgeIpc = {
    async invoke(channel, payload) {
      if (channel !== requestChannel("settings.update")) throw new Error(`unexpected ${channel}`);
      return store.update(requests["settings.update"].request.parse(payload));
    },
    on: () => () => {},
  };
  const info = {
    version: "0.1.0",
    platform: "darwin",
    arch: "arm64",
    electron: "1",
    packaged: false,
  } as const;
  return createBridge(ipc, info).settings;
}

/** Every setting away from its default, so a reset to a default shows. */
const customised: DesktopSettings = {
  openAtLogin: true,
  background: false,
  preventSleep: true,
  attention: false,
  globalShortcut: "CommandOrControl+J",
  notifications: {
    enabled: false,
    categories: { finished: false, failed: true },
    quietHours: { start: 22 * 60, end: 7 * 60 },
  },
};

/** One change per control in Settings › General › App, plus a notifications change. */
const changes: [string, DesktopSettingsPatch][] = [
  ["Open ace at login", { openAtLogin: false }],
  ["Keep running in background", { background: true }],
  ["Prevent sleep while agents work", { preventSleep: false }],
  ["Bounce dock icon for attention", { attention: true }],
  ["Quick-thread global shortcut", { globalShortcut: "CommandOrControl+Shift+K" }],
  ["Quick-thread global shortcut cleared", { globalShortcut: null }],
  ["notifications on", { notifications: { enabled: true } }],
];

/** A fake OS: what is registered right now, and every login-item change (each shows a macOS banner). */
function fakeOs() {
  const os = { loginItem: false, loginItemChanges: [] as boolean[], shortcuts: new Set<string>() };
  const apply = settingsEffects({
    loginItem: {
      enabled: () => os.loginItem,
      setEnabled: (on) => {
        os.loginItem = on;
        os.loginItemChanges.push(on);
      },
    },
    shortcuts: {
      register: (accelerator) => {
        os.shortcuts.add(accelerator);
        return true;
      },
      unregister: (accelerator) => os.shortcuts.delete(accelerator),
    },
    warn: () => {},
  });
  return { os, apply };
}

test.each(changes)(
  "changing %s from the page changes only that setting, on disk and in the OS",
  async (_, patch) => {
    const path = join(await root(), "settings.json");
    await new SettingsStore(path).update(customised);
    // A restart: the saved settings are applied once, then every change is.
    const store = new SettingsStore(path);
    const { os, apply } = fakeOs();
    apply(store.get());
    store.onChange(apply);
    os.loginItemChanges.length = 0;

    await settingsPage(store).update(patch);

    const expected = {
      ...customised,
      ...patch,
      notifications: { ...customised.notifications, ...patch.notifications },
    };
    expect(store.get()).toEqual(expected);
    expect(new SettingsStore(path).get()).toEqual(expected);
    expect(os.loginItem).toBe(expected.openAtLogin);
    expect(os.loginItemChanges).toEqual(
      expected.openAtLogin === customised.openAtLogin ? [] : [expected.openAtLogin],
    );
    expect([...os.shortcuts]).toEqual(expected.globalShortcut ? [expected.globalShortcut] : []);
  },
);

test("changing one notification category keeps the others and leaves prevent-sleep on", async () => {
  const path = join(await root(), "settings.json");
  const store = new SettingsStore(path);
  await store.update(customised);

  await settingsPage(store).update({ notifications: { categories: { needsYou: false } } });

  expect(store.get()).toMatchObject({
    preventSleep: true,
    notifications: {
      enabled: false,
      categories: { finished: false, failed: true, needsYou: false },
      quietHours: { start: 22 * 60, end: 7 * 60 },
    },
  });
});
