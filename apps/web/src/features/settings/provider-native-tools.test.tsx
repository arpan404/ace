import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });
beforeEach(() => localStorage.clear());

/** The settings row titled `title`, inside the section labelled `section`. */
async function rowOf(title: string) {
  const label = await screen.findByText(title, { selector: "label, div" });
  const row = label.closest<HTMLElement>("[data-setting-slot]");
  if (!row) throw new Error(`No ${title} row`);
  return row;
}

test("Codex's own tools list each tool with its state and why it isn't ready", async () => {
  await harness().open("/settings/providers/codex");
  await screen.findByText("Codex's own tools");
  expect(within(await rowOf("Computer use")).getByText("Ready")).toBeTruthy();
  expect(within(await rowOf("Chrome")).getByText("Ready")).toBeTruthy();
  const browser = await rowOf("In-app browser");
  expect(within(browser).getByText("Unavailable")).toBeTruthy();
  expect(
    within(browser).getByText("Needs the ChatGPT app; Chrome and ace's browser still work"),
  ).toBeTruthy();
  expect(within(await rowOf("Plugins and tools from")).getByText("/Users/ada/.codex")).toBeTruthy();
});

test("Claude in Chrome's control saves on, off and back to auto", async () => {
  const app = harness();
  await app.open("/settings/providers/claude");
  const row = await rowOf("Claude in Chrome");
  await within(row).findByText("Follows Claude's settings");
  const saved = () => app.daemon.services.settings.get("providers.claude.chrome");
  await userEvent.click(await within(row).findByRole("button", { name: "On" }));
  await waitFor(() => expect(saved()).toBe("on"));
  await userEvent.click(within(row).getByRole("button", { name: "Off" }));
  await waitFor(() => expect(saved()).toBe("off"));
  await within(row).findByText("Turned off in ace");
  await userEvent.click(within(row).getByRole("button", { name: "Auto" }));
  await waitFor(() => expect(saved()).toBe("auto"));
});

test("another Codex tool folder is saved, shows why it can't be used, and Use default resets it", async () => {
  const app = harness();
  await app.open("/settings/providers/codex");
  const row = await rowOf("Plugins and tools from");
  expect(within(row).queryByRole("button", { name: "Use default" })).toBeNull();
  await userEvent.click(await within(row).findByRole("button", { name: "Change…" }));
  const dialog = await screen.findByRole("dialog");
  const field = within(dialog).getByLabelText("Folder path");
  await userEvent.clear(field);
  await userEvent.type(field, "elsewhere");
  await userEvent.click(within(dialog).getByRole("button", { name: "Use folder" }));
  await within(dialog).findByText("Use the folder's full path.");
  expect(app.daemon.services.settings.get("providers.codex.toolSource")).toBeNull();
  await userEvent.clear(field);
  await userEvent.type(field, "/Volumes/tools");
  await userEvent.click(within(dialog).getByRole("button", { name: "Use folder" }));
  await waitFor(() =>
    expect(app.daemon.services.settings.get("providers.codex.toolSource")).toBe("/Volumes/tools"),
  );
  await within(row).findByText("/Volumes/tools");
  expect(within(row).getByText("No config.toml in this folder")).toBeTruthy();
  await userEvent.click(within(row).getByRole("button", { name: "Use default" }));
  await waitFor(() =>
    expect(app.daemon.services.settings.get("providers.codex.toolSource")).toBeNull(),
  );
  await within(row).findByText("/Users/ada/.codex");
  expect(within(row).queryByText("No config.toml in this folder")).toBeNull();
});

test("a provider that reports no tools of its own has no tools section", async () => {
  await harness().open("/settings/providers/opencode");
  await screen.findByText("Advanced");
  expect(screen.queryByText(/own tools$/)).toBeNull();
});
