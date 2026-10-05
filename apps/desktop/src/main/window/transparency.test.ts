import { describe, expect, it } from "vitest";
import { translucentCss } from "./options.ts";
import { WindowMaterial } from "./transparency.ts";

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A window and page that keep the state Electron would show. */
function fakeWindow(platform: NodeJS.Platform, reducedTransparency: boolean) {
  const shown = {
    vibrancy: undefined as string | null | undefined,
    material: undefined as string | undefined,
    background: undefined as string | undefined,
    css: new Map<string, string>(),
  };
  let next = 0;
  const material = new WindowMaterial({
    platform,
    reducedTransparency,
    window: {
      setVibrancy: (type) => void (shown.vibrancy = type),
      setBackgroundMaterial: (value) => void (shown.material = value),
      setBackgroundColor: (color) => void (shown.background = color),
    },
    page: {
      insertCSS: async (css) => {
        const key = `key-${next++}`;
        shown.css.set(key, css);
        return key;
      },
      removeInsertedCSS: async (key) => void shown.css.delete(key),
    },
  });
  const seeThrough = () => [...shown.css.values()].filter((css) => css === translucentCss).length;
  return { material, shown, seeThrough, settle };
}

describe("Reduce Transparency while ace runs", () => {
  it("turns a macOS window solid and its page opaque when switched on, and back when off", async () => {
    const window = fakeWindow("darwin", false);
    window.material.pageLoaded();
    await window.settle();
    expect(window.seeThrough()).toBe(1);

    window.material.update(true, true);
    await window.settle();
    expect(window.shown.vibrancy).toBeNull();
    expect(window.shown.background).toBe("#0a0a0a");
    expect(window.seeThrough()).toBe(0);

    window.material.update(false, true);
    await window.settle();
    expect(window.shown.vibrancy).toBe("sidebar");
    expect(window.shown.background).toBe("#00000000");
    expect(window.seeThrough()).toBe(1);
  });

  it("ignores theme updates that leave the setting as it was", async () => {
    const window = fakeWindow("darwin", false);
    window.material.pageLoaded();
    window.material.update(false, false);
    window.material.update(false, true);
    await window.settle();
    expect(window.shown.vibrancy).toBeUndefined();
    expect(window.seeThrough()).toBe(1);
  });

  it("repaints an opaque window's background when the system switches light and dark", () => {
    const linux = fakeWindow("linux", false);
    linux.material.update(false, false);
    expect(linux.shown.background).toBe("#f6f6f7");
    linux.material.update(false, true);
    expect(linux.shown.background).toBe("#0a0a0a");

    const reduced = fakeWindow("darwin", true);
    reduced.material.update(true, true);
    expect(reduced.shown.background).toBe("#0a0a0a");
    reduced.material.update(true, false);
    expect(reduced.shown.background).toBe("#f6f6f7");
  });

  it("switches Mica on Windows", async () => {
    const window = fakeWindow("win32", false);
    window.material.pageLoaded();
    window.material.update(true, false);
    await window.settle();
    expect(window.shown.material).toBe("none");
    expect(window.shown.background).toBe("#f6f6f7");
    expect(window.seeThrough()).toBe(0);
    window.material.update(false, false);
    expect(window.shown.material).toBe("mica");
  });

  it("gives a reloaded page the see-through CSS only while the window is translucent", async () => {
    const window = fakeWindow("darwin", true);
    window.material.pageLoaded();
    await window.settle();
    expect(window.seeThrough()).toBe(0);
    window.material.update(false, false);
    // The reload replaces the document; its new styles start without the CSS.
    window.shown.css.clear();
    window.material.pageLoaded();
    await window.settle();
    expect(window.seeThrough()).toBe(1);
  });

  it("keeps a Linux window solid whatever the setting", async () => {
    const window = fakeWindow("linux", false);
    window.material.pageLoaded();
    window.material.update(true, false);
    window.material.update(false, false);
    await window.settle();
    expect(window.seeThrough()).toBe(0);
    expect(window.shown.vibrancy).toBeUndefined();
    expect(window.shown.material).toBeUndefined();
  });
});
