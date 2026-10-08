import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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
  press(palette, { key: "y", code: "KeyY", ctrlKey: true, shiftKey: true });
  expect(palette.textContent).toBe("Shift+Ctrl+Y");

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
  expect((await shortcut("Agents")).textContent).toBe("Ctrl+Shift+A");
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

test("shortcuts are grouped, filterable, and a rebound one is marked", async () => {
  await harness().open("/settings/keyboard");
  const general = await screen.findByRole("region", { name: "General" });
  expect(within(general).getByRole("button", { name: "Command palette shortcut" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Go to" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Terminal & browser" })).toBeTruthy();

  await userEvent.type(screen.getByRole("searchbox", { name: "Filter shortcuts" }), "Alt+Ctrl+O");
  expect(
    screen.getByRole("button", { name: "Show or hide the thread's work card shortcut" }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Command palette shortcut" })).toBeNull();
  await userEvent.clear(screen.getByRole("searchbox", { name: "Filter shortcuts" }));

  const palette = screen.getByRole("button", { name: "Command palette shortcut" });
  const again = screen.getByRole("region", { name: "General" });
  expect(palette.getAttribute("aria-describedby")).toBeTruthy();
  const described = document.getElementById(palette.getAttribute("aria-describedby") ?? "");
  expect(described?.textContent).toBe("Ctrl+K. Press to change.");
  expect(within(again).queryByRole("img", { name: "Changed" })).toBeNull();
  await userEvent.click(palette);
  press(palette, { key: "y", code: "KeyY", ctrlKey: true, shiftKey: true });
  expect(within(again).getByRole("img", { name: "Changed" })).toBeTruthy();
});

test("sequences and plain keys are shown, not recorded; shortcuts say where they work", async () => {
  await harness().open("/settings/keyboard");
  const goTo = await screen.findByRole("region", { name: "Go to" });
  expect(within(goTo).queryByRole("button", { name: "Go to Home shortcut" })).toBeNull();
  expect(within(goTo).getAllByText("Sequence").length).toBeGreaterThan(0);
  const thread = screen.getByRole("region", { name: "Thread" });
  expect(within(thread).getAllByText("In a thread").length).toBeGreaterThan(0);
});

test("a key the browser keeps is refused, and a taken one can be swapped", async () => {
  await harness().open("/settings/keyboard");
  const settings = await shortcut("Settings");
  await userEvent.click(settings);
  press(settings, { key: "w", code: "KeyW", ctrlKey: true });
  expect(screen.getByRole("alert").textContent).toBe("Ctrl+W is used by the browser.");

  press(settings, { key: "k", code: "KeyK", ctrlKey: true });
  expect(screen.getByRole("alert").textContent).toBe("Ctrl+K is already Command palette.");
  await userEvent.click(screen.getByRole("button", { name: "Use anyway" }));
  expect((await shortcut("Settings")).textContent).toBe("Ctrl+K");
  expect((await shortcut("Command palette")).textContent).toBe("Ctrl+,");
});

test("a conflict can be swapped from the keyboard: Shift+Tab reaches Use anyway", async () => {
  await harness().open("/settings/keyboard");
  const settings = await shortcut("Settings");
  await userEvent.click(settings);
  press(settings, { key: "k", code: "KeyK", ctrlKey: true });
  await userEvent.tab({ shift: true });
  const useAnyway = screen.getByRole("button", { name: "Use anyway" });
  expect(document.activeElement).toBe(useAnyway);
  await userEvent.keyboard("{Enter}");
  expect((await shortcut("Settings")).textContent).toBe("Ctrl+K");
  expect((await shortcut("Command palette")).textContent).toBe("Ctrl+,");
});

test("retrying an older refused change never undoes a newer one that was saved", async () => {
  const app = harness();
  await app.open("/settings/keyboard");
  // A: refused, so it goes back.
  app.daemon.failRequests("settings.set");
  const agents = await shortcut("Agents");
  await userEvent.click(agents);
  press(agents, { key: "u", code: "KeyU", ctrlKey: true, altKey: true });
  await waitFor(async () => expect((await shortcut("Agents")).textContent).toBe("Ctrl+Shift+A"));

  // B: saved.
  app.daemon.restoreRequests();
  const settings = await shortcut("Settings");
  await userEvent.click(settings);
  press(settings, { key: "y", code: "KeyY", ctrlKey: true, shiftKey: true });
  await waitFor(() =>
    expect(app.daemon.services.settings.get("clients.keybindings")).toEqual({
      settings: "shift+mod+y",
    }),
  );

  // Retry A, refused again: B stays, on screen and on the daemon.
  app.daemon.failRequests("settings.set");
  await userEvent.click(
    (await screen.findAllByRole("button", { name: "Retry", hidden: true }))[0] ?? document.body,
  );
  await waitFor(async () =>
    expect((await screen.findAllByRole("button", { name: "Retry", hidden: true })).length).toBe(1),
  );
  expect((await shortcut("Settings")).textContent).toBe("Shift+Ctrl+Y");
  expect((await shortcut("Agents")).textContent).toBe("Ctrl+Shift+A");

  // Retry A once the daemon takes it: A lands on top of B, not instead of it.
  app.daemon.restoreRequests();
  await userEvent.click(
    (await screen.findAllByRole("button", { name: "Retry", hidden: true }))[0] ?? document.body,
  );
  await waitFor(() =>
    expect(app.daemon.services.settings.get("clients.keybindings")).toEqual({
      settings: "shift+mod+y",
      agents: "alt+mod+u",
    }),
  );
});
