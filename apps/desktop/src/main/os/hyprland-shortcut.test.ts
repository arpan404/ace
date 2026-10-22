import { expect, test } from "vitest";
import { hyprlandBind, hyprlandShortcutHint } from "./hyprland-shortcut.ts";

const hyprland = { HYPRLAND_INSTANCE_SIGNATURE: "abc", WAYLAND_DISPLAY: "wayland-1" };
const listing = [
  { name: "org.example.other:toggle", description: "Other app" },
  {
    name: "dev.ace.app:3f9a0c-CommandOrControl+Shift+Space",
    description: "Electron shortcut: CommandOrControl+Shift+Space",
  },
];

test("on Hyprland Settings gives the hyprland.conf line that binds ace's registered shortcut", async () => {
  const hint = await hyprlandShortcutHint({
    env: hyprland,
    accelerator: "CommandOrControl+Shift+Space",
    run: async (file, args) => {
      expect([file, ...args]).toEqual(["hyprctl", "globalshortcuts", "-j"]);
      return JSON.stringify(listing);
    },
  });
  expect(hint).toBe(
    "Hyprland gives apps' shortcuts no keys. Add this line to hyprland.conf: bind = CTRL SHIFT, Space, global, dev.ace.app:3f9a0c-CommandOrControl+Shift+Space",
  );
});

const run = async () => JSON.stringify(listing);

test("there is no hint off Hyprland, before Hyprland lists the shortcut, or when hyprctl fails", async () => {
  expect(
    await hyprlandShortcutHint({ env: {}, accelerator: "CommandOrControl+Shift+Space", run }),
  ).toBeUndefined();
  expect(
    await hyprlandShortcutHint({ env: hyprland, accelerator: "Alt+Shift+K", run }),
  ).toBeUndefined();
  expect(
    await hyprlandShortcutHint({
      env: hyprland,
      accelerator: "CommandOrControl+Shift+Space",
      run: async () => {
        throw new Error("hyprctl: not found");
      },
    }),
  ).toBeUndefined();
  expect(await hyprlandShortcutHint({ env: hyprland, accelerator: null, run })).toBeUndefined();
});

test("another app's shortcut with the same keys is never offered as ace's", () => {
  expect(
    hyprlandBind(
      [{ name: "org.other:x", description: "Electron shortcut: Alt+Shift+K" }],
      "Alt+Shift+K",
    ),
  ).toBeUndefined();
  expect(
    hyprlandBind(
      [{ name: "dev.ace.app:abc-Alt+Shift+K", description: "Electron shortcut: Alt+Shift+K" }],
      "Alt+Shift+K",
    ),
  ).toBe("bind = ALT SHIFT, K, global, dev.ace.app:abc-Alt+Shift+K");
});
