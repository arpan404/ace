import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { workbenchServices } from "@ace/fake-daemon";
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
