import { expect, test } from "vitest";
import { desktopMatchMedia } from "./desktop-color-scheme.ts";

/** The page's own media queries: light, and never changing (as on Windows). */
function pageMedia(query: string): MediaQueryList {
  return {
    matches: query === "(prefers-reduced-motion: reduce)",
    media: query,
    addEventListener() {},
    removeEventListener() {},
  } as unknown as MediaQueryList;
}

function bridge(platform: string, dark: boolean) {
  const listeners: ((value: unknown) => void)[] = [];
  const scope = {
    ace: {
      platform,
      theme: {
        appearance: async () => ({ dark, highContrast: false }),
        onChange: (listener: (value: unknown) => void) => listeners.push(listener),
      },
    },
  };
  return { scope, send: (value: unknown) => listeners.forEach((listener) => listener(value)) };
}

test("the Windows app's System mode follows the OS dark mode the desktop reports", async () => {
  const { scope, send } = bridge("win32", true);
  const media = desktopMatchMedia(pageMedia, scope);
  await Promise.resolve();
  await Promise.resolve();
  const dark = media("(prefers-color-scheme: dark)");
  expect(dark.matches).toBe(true);

  const heard: boolean[] = [];
  dark.addEventListener("change", (event) => heard.push(event.matches));
  send({ dark: false });
  expect(media("(prefers-color-scheme: dark)").matches).toBe(false);
  send({ dark: false });
  send({ dark: true });
  expect(heard).toEqual([false, true]);
  // Other queries stay the page's own.
  expect(media("(prefers-reduced-motion: reduce)").matches).toBe(true);
});

test("macOS, Linux and browsers keep the page's own media queries", async () => {
  for (const platform of ["darwin", "linux"]) {
    const { scope } = bridge(platform, true);
    const media = desktopMatchMedia(pageMedia, scope);
    await Promise.resolve();
    expect(media("(prefers-color-scheme: dark)").matches).toBe(false);
  }
  expect(desktopMatchMedia(pageMedia, {})).toBe(pageMedia);
});
