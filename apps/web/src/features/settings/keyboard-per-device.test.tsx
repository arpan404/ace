import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { fakeDesktopSettings as desktop } from "@/test/desktop-settings.ts";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

afterEach(() => vi.unstubAllGlobals());

// jsdom reports a non-Apple platform, so keys render as Ctrl+ and record Ctrl as mod.
const shortcut = (label: string) => screen.findByRole("button", { name: `${label} shortcut` });

async function rebindPalette() {
  const palette = await shortcut("Command palette");
  await userEvent.click(palette);
  fireEvent.keyDown(palette, { key: "y", code: "KeyY", ctrlKey: true, shiftKey: true });
  expect(palette.textContent).toBe("Shift+Ctrl+Y");
}

test("a shortcut rebound on one device stays on it and doesn't reach another device on the same machine", async () => {
  const laptop = harness();
  await laptop.open("/settings/keyboard");
  await rebindPalette();
  cleanup();

  const phone = harness({ daemon: laptop.daemon, storage: memoryKeyValue() });
  await phone.open("/settings/keyboard");
  expect((await shortcut("Command palette")).textContent).toBe("Ctrl+K");
  expect(laptop.daemon.services.settings.get("clients.keybindings")).toEqual({});
  cleanup();

  const again = harness({ daemon: laptop.daemon, storage: laptop.storage });
  await again.open("/settings/keyboard");
  expect((await shortcut("Command palette")).textContent).toBe("Shift+Ctrl+Y");
});

test("a device's first start adopts the machine's old shared shortcuts, then ignores that setting", async () => {
  const first = harness();
  first.daemon.services.settings.seed({ "clients.keybindings": { palette: "alt+mod+p" } });
  await first.open("/settings/keyboard");
  await waitFor(async () =>
    expect((await shortcut("Command palette")).textContent).toBe("Alt+Ctrl+P"),
  );
  cleanup();

  // Another client still writing the old setting no longer moves this device's shortcuts.
  first.daemon.services.settings.seed({ "clients.keybindings": { palette: "alt+mod+q" } });
  const later = harness({ daemon: first.daemon, storage: first.storage });
  await later.open("/settings/keyboard");
  expect((await shortcut("Command palette")).textContent).toBe("Alt+Ctrl+P");
});

test("Reset all shortcuts restores this device's defaults without touching the machine", async () => {
  const app = harness();
  app.daemon.services.settings.seed({ "clients.keybindings": { palette: "alt+mod+p" } });
  await app.open("/settings/keyboard");
  await waitFor(async () =>
    expect((await shortcut("Command palette")).textContent).toBe("Alt+Ctrl+P"),
  );

  await userEvent.click(screen.getByRole("button", { name: "Reset all shortcuts" }));

  expect((await shortcut("Command palette")).textContent).toBe("Ctrl+K");
  expect(app.daemon.services.settings.get("clients.keybindings")).toEqual({ palette: "alt+mod+p" });
});

test("in the desktop app, rebound shortcuts are kept in the app's own settings, not the browser's", async () => {
  const app = desktop();
  const made = harness();
  await made.open("/settings/keyboard");
  await waitFor(() => expect(app.stored().keybindings).toEqual({}));

  await rebindPalette();

  await waitFor(() => expect(app.stored().keybindings).toEqual({ palette: "shift+mod+y" }));
  expect(made.storage.getItem("ace.keybindings")).toBeNull();
});

test("in the desktop app, the quick-thread global shortcut is on Keyboard, under Global", async () => {
  desktop();
  const app = harness();
  await app.open("/settings/keyboard");
  const global = await screen.findByRole("region", { name: "Global" });
  expect(within(global).getByRole("button", { name: "Quick-thread global shortcut" })).toBeTruthy();

  const nav = screen.getByRole("navigation", { name: "Settings pages" });
  await userEvent.click(within(nav).getByRole("link", { name: "General" }));
  await screen.findByRole("switch", { name: "Open ace at login" });
  expect(screen.queryByRole("button", { name: "Quick-thread global shortcut" })).toBeNull();
});

test("in a browser, Keyboard has no global shortcuts", async () => {
  await harness().open("/settings/keyboard");
  await shortcut("Command palette");
  expect(screen.queryByRole("region", { name: "Global" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Quick-thread global shortcut" })).toBeNull();
});
