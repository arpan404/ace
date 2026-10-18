import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { ThemeProvider } from "@/theme/theme-provider.tsx";
import type { PreviewSource } from "../sources.ts";
import { useCursorStyle } from "./use-cursor-style.ts";

/** The colours the daemon is told to draw agents' cursors in, for one saved appearance. */
function reported(appearance: Record<string, unknown>) {
  const saved = new Map([["ace.appearance", JSON.stringify(appearance)]]);
  const styles: { fill: string; outline: string }[] = [];
  const source = {
    cursorStyle: (_threadId: string, style: { fill: string; outline: string }) =>
      styles.push(style),
  } as Partial<PreviewSource> as PreviewSource;
  function Probe() {
    useCursorStyle(source, "thread");
    return null;
  }
  render(
    <ThemeProvider
      environment={{
        storage: {
          getItem: (key) => saved.get(key) ?? null,
          setItem: (key, value) => void saved.set(key, value),
          removeItem: (key) => void saved.delete(key),
        },
        root: document.createElement("div"),
      }}
    >
      <Probe />
    </ThemeProvider>,
  );
  return styles.at(-1);
}

const luminance = (hex: string) => {
  const value = Number.parseInt(hex.slice(1), 16);
  return ((value >> 16) & 255) * 0.2126 + ((value >> 8) & 255) * 0.7152 + (value & 255) * 0.0722;
};

test("the cursor follows the accent the person picks", () => {
  const green = reported({ mode: "light", accent: "custom", customAccent: "#2E8B57" });
  const red = reported({ mode: "light", accent: "custom", customAccent: "#C0392B" });
  expect(green?.fill).toMatch(/^#[0-9a-f]{6}$/i);
  expect(red?.fill).toMatch(/^#[0-9a-f]{6}$/i);
  expect(green?.fill).not.toBe(red?.fill);
});

test("a pale accent gets a dark outline so the cursor still reads", () => {
  // Ink in dark mode is near-white; its outline must not be white too.
  const ink = reported({ mode: "dark", accent: "ink" });
  expect(luminance(ink?.fill ?? "#000000")).toBeGreaterThan(160);
  expect(luminance(ink?.outline ?? "#FFFFFF")).toBeLessThan(90);
  const light = reported({ mode: "light", accent: "ink" });
  expect(luminance(light?.outline ?? "#000000")).toBeGreaterThan(200);
});
