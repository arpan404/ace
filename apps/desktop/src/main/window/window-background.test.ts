import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { windowBackground, WindowBackgroundStore } from "./window-background.ts";

const tide = { light: "#f4f8fa", dark: "#0f1a1f" };

test("the window starts in the page's theme colour for the scheme its mode picks", () => {
  expect(windowBackground({ mode: "light", ...tide }, true)).toBe("#f4f8fa");
  expect(windowBackground({ mode: "dark", ...tide }, false)).toBe("#0f1a1f");
  // "System" follows the OS, including a change of scheme between launches.
  expect(windowBackground({ mode: "system", ...tide }, true)).toBe("#0f1a1f");
  expect(windowBackground({ mode: "system", ...tide }, false)).toBe("#f4f8fa");
});

test("before the page has said, the window uses the default theme's colour", () => {
  expect(windowBackground(undefined, true)).toBe("#161616");
  expect(windowBackground(undefined, false)).toBe("#fdfdfd");
});

test("the colours the page reports outlive a restart", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "ace-window-bg-")), "window-background.json");
  const store = new WindowBackgroundStore(path);
  const first = store.set({ mode: "dark", ...tide });
  expect(first.changed).toBe(true);
  expect(store.set({ mode: "dark", ...tide }).changed).toBe(false);
  await first.saved;
  expect(new WindowBackgroundStore(path).get()).toEqual({ mode: "dark", ...tide });
});
