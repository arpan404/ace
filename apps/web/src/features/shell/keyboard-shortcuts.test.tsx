import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { coldStartReplay, multiDayDemo, seedPanels, workbenchServices } from "@ace/fake-daemon";
import { harness } from "@/test/harness.tsx";

// jsdom is a non-Apple browser tab: "mod" is Ctrl and keys render as "Shift+Ctrl+Y".
const heading = (name: string) => screen.findByRole("heading", { level: 1, name });
const palette = () => screen.queryByRole("combobox", { name: "Search commands" });

test("a rebound shortcut works at once, its old keys stop, and the palette shows the new keys", async () => {
  await harness().open("/settings/keyboard");
  const settings = await screen.findByRole("button", { name: "Settings shortcut" });
  await userEvent.click(settings);
  fireEvent.keyDown(settings, { key: "y", code: "KeyY", ctrlKey: true, shiftKey: true });
  expect(settings.textContent).toBe("Shift+Ctrl+Y");

  await userEvent.click(
    within(screen.getByRole("navigation", { name: "Views" })).getByRole("link", { name: /^Home/ }),
  );
  await heading("Home");
  await userEvent.keyboard("{Control>},{/Control}");
  expect(screen.queryByRole("heading", { level: 1, name: "Settings" })).toBeNull();
  await userEvent.keyboard("{Control>}{Shift>}y{/Shift}{/Control}");
  await heading("Settings");

  await userEvent.keyboard("{Control>}k{/Control}");
  await waitFor(() => expect(palette()).toBeTruthy());
  const row = within(screen.getByRole("listbox")).getByRole("option", { name: /^Settings/ });
  expect(row.textContent).toMatch(/Shift\+Ctrl\+Y$/);
});

test("Reset brings the default keys back", async () => {
  await harness().open("/settings/keyboard");
  const paletteRow = await screen.findByRole("button", { name: "Command palette shortcut" });
  await userEvent.click(paletteRow);
  fireEvent.keyDown(paletteRow, { key: "y", code: "KeyY", ctrlKey: true, shiftKey: true });
  await waitFor(() => expect(paletteRow.textContent).toBe("Shift+Ctrl+Y"));

  await userEvent.keyboard("{Control>}{Shift>}y{/Shift}{/Control}");
  await waitFor(() => expect(palette()).toBeTruthy());
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(palette()).toBeNull());
  // The palette's code is loaded now, so it would show at once if Ctrl+K still opened it.
  await userEvent.keyboard("{Control>}k{/Control}");
  expect(palette()).toBeNull();

  await userEvent.click(screen.getByRole("button", { name: "Reset Command palette" }));
  await waitFor(async () =>
    expect(
      (await screen.findByRole("button", { name: "Command palette shortcut" })).textContent,
    ).toBe("Ctrl+K"),
  );
  await userEvent.keyboard("{Control>}k{/Control}");
  await waitFor(() => expect(palette()).toBeTruthy());
});

test("in a browser tab New thread is Ctrl+Alt+N, which the browser leaves to the page", async () => {
  const app = harness();
  app.daemon.seedServices(workbenchServices(Date.now()));
  await app.open("/");
  await heading("Home");
  const link = await screen.findByRole("link", { name: /^New thread/ });
  expect(link.textContent).toMatch(/Alt\+Ctrl\+N$/);
  await userEvent.keyboard("{Control>}{Alt>}n{/Alt}{/Control}");
  await heading("New thread");
});

const bar = () => screen.queryByRole("search", { name: "Search this thread" });
const recorder = (label: string) => screen.findByRole("button", { name: `${label} shortcut` });
function record(row: HTMLElement, init: KeyboardEventInit) {
  fireEvent.keyDown(row, init);
}

test("a rebound thread search answers its new keys and no longer the old ones", async () => {
  const app = harness();
  app.play(multiDayDemo("thread-multi-day", 3, { scans: 2 })).runUntilBlocked();
  const settings = await app.open("/settings/keyboard");
  const find = await recorder("Search this thread");
  await userEvent.click(find);
  record(find, { key: "y", code: "KeyY", ctrlKey: true, shiftKey: true });
  await waitFor(() => expect(find.textContent).toBe("Shift+Ctrl+Y"));
  settings.unmount();

  await app.open("/t/thread-multi-day");
  await screen.findByRole("feed", { name: "Transcript" });
  await userEvent.keyboard("{Control>}{Shift>}y{/Shift}{/Control}");
  await waitFor(() => expect(bar()).toBeTruthy());
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(bar()).toBeNull());
  await userEvent.keyboard("{Control>}f{/Control}");
  expect(bar()).toBeNull();
});

test("the terminal's find shows the key the terminal takes, which can't be changed", async () => {
  const app = harness();
  app.play(coldStartReplay()).runThrough("turn-2");
  seedPanels(app.daemon);
  await app.open("/t/thread-cold-start");
  await heading("Cap cold-start replay at 200 events");
  await userEvent.keyboard("{Control>}`{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  (await within(panel).findByRole("button", { name: "Find" })).focus();
  // Off Apple the terminal keeps Ctrl+F for the shell and finds with Ctrl+Shift+F.
  expect((await screen.findByRole("tooltip")).textContent).toBe("FindShift+Ctrl+F");
});

test("fixed keys are listed but can't be recorded or reset", async () => {
  await harness().open("/settings/keyboard");
  await recorder("Command palette");
  for (const label of ["Focus notifications", "Send", "Find in a terminal or log"]) {
    expect(screen.queryByRole("button", { name: `${label} shortcut` })).toBeNull();
    expect(screen.queryByRole("button", { name: `Reset ${label}` })).toBeNull();
  }
  expect(
    screen.getByText("Focus notifications").closest("div")?.parentElement?.textContent,
  ).toMatch(/Can't be changed/);
});

test("a row shows its own stored keys, even when they spell another shortcut's default", async () => {
  await harness().open("/settings/keyboard");
  const files = await recorder("Open a file");
  await userEvent.click(files);
  record(files, { key: "u", code: "KeyU", ctrlKey: true, altKey: true });
  await waitFor(() => expect(files.textContent).toBe("Alt+Ctrl+U"));

  // Ctrl+P is free now, and it is also how "Open a file" was spelled by default.
  const settings = await recorder("Settings");
  await userEvent.click(settings);
  record(settings, { key: "p", code: "KeyP", ctrlKey: true });
  await waitFor(() => expect(settings.textContent).toBe("Ctrl+P"));
});

test("keys another shortcut still answers through its browser alias are refused", async () => {
  await harness().open("/settings/keyboard");
  const newThread = await recorder("New thread");
  await userEvent.click(newThread);
  // In a browser tab New deck shows Alt+Shift+Ctrl+N but still answers Shift+Ctrl+N.
  record(newThread, { key: "n", code: "KeyN", ctrlKey: true, shiftKey: true });
  expect(screen.getByRole("alert").textContent).toBe("Shift+Ctrl+N is already New deck.");
});
