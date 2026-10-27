import { describe, expect, test } from "vitest";
import { desktopColorScheme } from "./desktop-color-scheme.ts";

const dark = "(prefers-color-scheme: dark)";

/** The page's own media queries: light, and never changing (as on Windows). */
function pageMedia(query: string): MediaQueryList {
  return {
    matches: query === "(prefers-reduced-motion: reduce)",
    media: query,
    addEventListener() {},
    removeEventListener() {},
  } as unknown as MediaQueryList;
}

function bridge(platform: string, answer: Promise<unknown>) {
  const listeners: ((value: unknown) => void)[] = [];
  const scope = {
    ace: {
      platform,
      theme: {
        appearance: () => answer,
        onChange: (listener: (value: unknown) => void) => listeners.push(listener),
      },
    },
  };
  return { scope, send: (value: unknown) => listeners.forEach((listener) => listener(value)) };
}

const never = () => new Promise<void>(() => {});

describe.runIf(process.platform === "win32")("the Windows app's System mode", () => {
  test("starts in the OS mode the desktop reports, even before anything listens", async () => {
    const { scope } = bridge("win32", Promise.resolve({ dark: true }));
    const scheme = desktopColorScheme(pageMedia, scope, never);
    await scheme.ready;
    // The first read after `ready`, as the theme's first render does it.
    expect(scheme.matchMedia(dark).matches).toBe(true);
  });

  test("follows the OS switching while it runs", async () => {
    const { scope, send } = bridge("win32", Promise.resolve({ dark: true }));
    const scheme = desktopColorScheme(pageMedia, scope, never);
    await scheme.ready;
    const list = scheme.matchMedia(dark);
    const heard: boolean[] = [];
    list.addEventListener("change", (event) => heard.push(event.matches));
    send({ dark: false });
    expect(scheme.matchMedia(dark).matches).toBe(false);
    send({ dark: false });
    send({ dark: true });
    expect(heard).toEqual([false, true]);
    expect(scheme.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
  });

  test("a switch that lands while the first answer is on its way is kept", async () => {
    const { promise, resolve: answer } = Promise.withResolvers<unknown>();
    const { scope, send } = bridge("win32", promise);
    const scheme = desktopColorScheme(pageMedia, scope, never);
    send({ dark: true });
    answer({ dark: true });
    await scheme.ready;
    expect(scheme.matchMedia(dark).matches).toBe(true);
  });

  test("never holds the first render when the desktop does not answer", async () => {
    const { scope } = bridge("win32", new Promise(() => {}));
    const scheme = desktopColorScheme(pageMedia, scope, () => Promise.resolve());
    await scheme.ready;
    expect(scheme.matchMedia(dark).matches).toBe(false);
  });

  test("macOS, Linux and browsers keep the page's own media queries", () => {
    for (const platform of ["darwin", "linux"]) {
      const { scope } = bridge(platform, Promise.resolve({ dark: true }));
      const scheme = desktopColorScheme(pageMedia, scope, never);
      expect(scheme.ready).toBeUndefined();
      expect(scheme.matchMedia).toBe(pageMedia);
    }
    expect(desktopColorScheme(pageMedia, {}).matchMedia).toBe(pageMedia);
  });
});
