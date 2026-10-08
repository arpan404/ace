import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

async function emptyProject() {
  const app = harness();
  app.daemon.projects.seedFolders("/home/dev", [{ path: "/home/dev/weather", git: true }]);
  await app.client.start();
  await waitFor(() => expect(app.client.state).toBe("ready"));
  await app.client.projects.add({ path: "/home/dev/weather" });
  return app;
}

test("empty Home and sidebar show the browser's New thread shortcut", async () => {
  await (await emptyProject()).open("/");
  const threads = await screen.findByRole("navigation", { name: "Threads" });
  expect(within(threads).getByText(/Start one with Alt\+Ctrl\+N/)).toBeTruthy();
  const main = screen.getByRole("main");
  expect(await within(main).findByText("Alt+Ctrl+N")).toBeTruthy();
  const app = screen.getByRole("navigation", { name: "App" });
  expect(within(app).getByRole("link", { name: /^New thread/ }).textContent).toContain(
    "Alt+Ctrl+N",
  );
});

test("changing New thread in the keymap updates both empty hints and the working shortcut", async () => {
  await (await emptyProject()).open("/settings/keyboard");
  const recorder = await screen.findByRole("button", { name: "New thread shortcut" });
  await userEvent.click(recorder);
  fireEvent.keyDown(recorder, { key: "y", code: "KeyY", ctrlKey: true, shiftKey: true });
  await userEvent.click(screen.getByRole("link", { name: "Automations" }));
  await screen.findByRole("heading", { name: "Automations", level: 1 });
  await userEvent.keyboard("gh");
  await screen.findByRole("heading", { name: "Home", level: 1 });
  const threads = await screen.findByRole("navigation", { name: "Threads" });
  expect(await within(threads).findByText(/Start one with Shift\+Ctrl\+Y/)).toBeTruthy();
  const main = screen.getByRole("main");
  expect(await within(main).findByText("Shift+Ctrl+Y")).toBeTruthy();
  await userEvent.keyboard("{Control>}{Shift>}y{/Shift}{/Control}");
  expect(await screen.findByRole("heading", { name: "New thread" })).toBeTruthy();
});

test("the project's Add action shows its rebound shortcut and that shortcut opens the chooser", async () => {
  await (await emptyProject()).open("/settings/keyboard");
  const recorder = await screen.findByRole("button", { name: "Add project shortcut" });
  await userEvent.click(recorder);
  fireEvent.keyDown(recorder, { key: "j", code: "KeyJ", ctrlKey: true, shiftKey: true });
  await userEvent.click(screen.getByRole("link", { name: "Automations" }));
  await screen.findByRole("heading", { name: "Automations", level: 1 });
  await userEvent.keyboard("gh");
  await screen.findByRole("heading", { name: "Home", level: 1 });
  await userEvent.click(screen.getByRole("button", { name: /^Project filter:/ }));
  expect((await screen.findByRole("menuitem", { name: /^Add project/ })).textContent).toContain(
    "Shift+Ctrl+J",
  );
  await userEvent.keyboard("{Escape}{Control>}{Shift>}j{/Shift}{/Control}");
  expect(await screen.findByRole("dialog", { name: "Add project" })).toBeTruthy();
});
