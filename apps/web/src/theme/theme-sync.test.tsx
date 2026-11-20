import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import type { KeyValueStorage } from "@ace/ui-core";
import { fakeSuit } from "@/test/fake-suits.ts";
import { ThemeProvider, useTheme } from "./theme-provider.tsx";

/** Two windows of the app on one origin: one storage, and the `storage` event between them. */
function twoWindows() {
  const saved = new Map<string, string>();
  const windows = new Set<{ listeners: Set<(key: string | null) => void> }>();
  return (root: HTMLElement) => {
    const self = { listeners: new Set<(key: string | null) => void>() };
    windows.add(self);
    const storage: KeyValueStorage = {
      getItem: (key) => saved.get(key) ?? null,
      setItem: (key, value) => {
        if (saved.get(key) === value) return;
        saved.set(key, value);
        // As the browser does: every other window hears of a change, never the one that wrote.
        for (const other of windows)
          if (other !== self) for (const listener of other.listeners) listener(key);
      },
      removeItem: (key) => void saved.delete(key),
    };
    return {
      storage,
      root,
      onStorage: (listener: (key: string | null) => void) => {
        self.listeners.add(listener);
        return () => void self.listeners.delete(listener);
      },
    };
  };
}

const dusk = fakeSuit({ id: "dusk-glass", dark: { canvas: "#1a1020" } });

/** The main window's Appearance page: a theme, or a Suit its library has read. */
function Choices() {
  const { update, reportSuits } = useTheme();
  return (
    <>
      <button type="button" onClick={() => update({ theme: "dusk" })}>
        Dusk theme
      </button>
      <button
        type="button"
        onClick={() => {
          reportSuits({ summaries: [dusk.summary], detail: dusk, preview: undefined });
          update({ suit: dusk.summary.id });
        }}
      >
        Dusk Suit
      </button>
    </>
  );
}

function mount() {
  const environment = twoWindows();
  const main = document.createElement("div");
  const popover = document.createElement("div");
  render(
    <>
      <ThemeProvider environment={environment(main)}>
        <Choices />
      </ThemeProvider>
      <ThemeProvider environment={environment(popover)}>{null}</ThemeProvider>
    </>,
  );
  return { main, popover };
}

test("a theme chosen in one window shows in the app's other windows", () => {
  const { main, popover } = mount();
  expect(popover.getAttribute("data-theme")).toBe("ace");
  fireEvent.click(screen.getByRole("button", { name: "Dusk theme" }));
  expect(main.getAttribute("data-theme")).toBe("dusk");
  expect(popover.getAttribute("data-theme")).toBe("dusk");
});

test("a Suit applied in one window shows in the others before they read it themselves", () => {
  const { main, popover } = mount();
  expect(popover.hasAttribute("data-suit")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Dusk Suit" }));
  expect(main.getAttribute("data-suit")).toBe("dusk-glass");
  expect(popover.getAttribute("data-suit")).toBe("dusk-glass");
});
