import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { recordChord } from "./keybindings.ts";

// jsdom reports a non-Apple platform, so keys render as Ctrl+ and record Ctrl as mod.
const shortcut = (label: string) => screen.findByRole("button", { name: `${label} shortcut` });

/** Press a chord on the focused recorder. Physical codes, as a real keyboard reports them. */
function press(target: HTMLElement, init: KeyboardEventInit) {
  fireEvent.keyDown(target, init);
}

test("a shortcut can be rebound by pressing the new keys, and reset to its default", async () => {
  await harness().open("/settings/keyboard");
  const palette = await shortcut("Command palette");
  expect(palette.textContent).toBe("Ctrl+K");

  await userEvent.click(palette);
  expect(palette.textContent).toBe("Press keys…");
  press(palette, { key: "p", code: "KeyP", ctrlKey: true, shiftKey: true });
  expect(palette.textContent).toBe("Shift+Ctrl+P");

  await userEvent.click(await screen.findByRole("button", { name: "Reset Command palette" }));
  expect((await shortcut("Command palette")).textContent).toBe("Ctrl+K");
});

test("a shortcut already in use is refused with the name of its owner", async () => {
  await harness().open("/settings/keyboard");
  const settings = await shortcut("Settings");
  await userEvent.click(settings);
  press(settings, { key: "k", code: "KeyK", ctrlKey: true });
  expect(screen.getByRole("alert").textContent).toBe("Ctrl+K is already Command palette.");
  expect(settings.textContent).toBe("Press keys…");

  press(settings, { key: "Escape", code: "Escape" });
  expect(settings.textContent).toBe("Ctrl+,");
});

test("a bare letter needs a modifier", async () => {
  await harness().open("/settings/keyboard");
  const terminal = await shortcut("Terminal");
  await userEvent.click(terminal);
  press(terminal, { key: "t", code: "KeyT" });
  expect(screen.getByRole("alert").textContent).toBe("Add Ctrl or Alt to the key.");
});

test("rebindings survive leaving Settings › Keyboard, and Reset all restores every default", async () => {
  await harness().open("/settings/keyboard");
  const agents = await shortcut("Agents");
  await userEvent.click(agents);
  press(agents, { key: "u", code: "KeyU", ctrlKey: true, altKey: true });
  const nav = screen.getByRole("navigation", { name: "Settings pages" });
  await userEvent.click(within(nav).getByRole("link", { name: "General" }));
  await userEvent.click(within(nav).getByRole("link", { name: "Keyboard" }));
  expect((await shortcut("Agents")).textContent).toBe("Alt+Ctrl+U");

  await userEvent.click(screen.getByRole("button", { name: "Reset all shortcuts" }));
  expect((await shortcut("Agents")).textContent).toBe("Ctrl+J");
  expect(screen.queryByRole("button", { name: "Reset all shortcuts" })).toBeNull();
});

test("Ctrl records as the portable mod key off Apple platforms, and as ctrl on them", () => {
  const event = {
    key: "b",
    code: "KeyB",
    metaKey: false,
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
  };
  expect(recordChord(event, false)).toEqual({ kind: "chord", keys: "mod+b" });
  expect(recordChord(event, true)).toEqual({ kind: "chord", keys: "ctrl+b" });
  expect(recordChord({ ...event, ctrlKey: false, key: "F5", code: "F5" }, true)).toEqual({
    kind: "chord",
    keys: "f5",
  });
});
