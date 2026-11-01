import { coldStartReplay, workbench } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { createIdleTask } from "@/test/tasks.ts";
import { setKeybindingOverrides } from "@/lib/keybindings.ts";

configure({ asyncUtilTimeout: 10000 });
afterEach(() => {
  localStorage.clear();
  setKeybindingOverrides({});
});

const threads = () => screen.getByRole("navigation", { name: "Threads" });
const tab = (name: "Inbox" | "Snoozed" | "Settled") =>
  within(threads()).getByRole("tab", { name: new RegExp(`^${name}`) });
const thumb = () => threads().querySelector("[data-selected-index]");
const nextTab = () => userEvent.keyboard("{Alt>}{Shift>}t{/Shift}{/Alt}");

/** The workbench, plus a finished thread at rest in the Inbox. */
async function openHome() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  createIdleTask(app.daemon, {
    id: "thread-readme",
    workspaceId: "relay",
    title: "Tidy the README",
    provider: "codex",
  });
  await app.open("/");
  await within(await screen.findByRole("navigation", { name: "Threads" })).findByRole("link", {
    name: /^Tidy the README/,
  });
  return app;
}

test("pressing 2 selects Snoozed and the indicator follows it", async () => {
  await openHome();
  expect(tab("Inbox").getAttribute("aria-selected")).toBe("true");
  expect(thumb()?.getAttribute("data-selected-index")).toBe("0");

  const link = within(threads()).getByRole("link", { name: /^Tidy the README/ });
  link.focus();
  await userEvent.keyboard("2");

  await waitFor(() => expect(tab("Snoozed").getAttribute("aria-selected")).toBe("true"));
  expect(thumb()?.getAttribute("data-selected-index")).toBe("1");
});

test("each tab tooltip shows its shortcut from the keymap", async () => {
  await openHome();
  // jsdom is a non-Apple browser tab, so the digit shortcuts resolve to their Alt+Shift forms.
  await userEvent.hover(tab("Inbox"));
  expect((await screen.findByRole("tooltip")).textContent ?? "").toContain("Alt+Shift+1");
});

test("the global shortcut selects Snoozed with focus in the composer, staying on the thread", async () => {
  const app = harness();
  app.play(coldStartReplay()).runThrough("turn-2");
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });

  screen.getByRole("combobox", { name: "Message" }).focus();
  await userEvent.keyboard("{Alt>}{Shift>}2{/Shift}{/Alt}");

  await waitFor(() => expect(tab("Snoozed").getAttribute("aria-selected")).toBe("true"));
  // The open thread stays open: only the panel's tab switched.
  expect(
    screen.getByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" }),
  ).toBeTruthy();
});

test("the global shortcut switches to the Threads place first when elsewhere", async () => {
  await harness().open("/automations");
  await screen.findByRole("heading", { level: 1, name: "Automations" });
  expect(screen.queryByRole("navigation", { name: "Threads" })).toBeNull();

  await userEvent.keyboard("{Alt>}{Shift>}2{/Shift}{/Alt}");

  await waitFor(() => expect(tab("Snoozed").getAttribute("aria-selected")).toBe("true"));
  expect(await screen.findByRole("navigation", { name: "Threads" })).toBeTruthy();
});

test("Next threads tab cycles through all three", async () => {
  await openHome();

  await nextTab();
  await waitFor(() => expect(tab("Snoozed").getAttribute("aria-selected")).toBe("true"));
  expect(thumb()?.getAttribute("data-selected-index")).toBe("1");

  await nextTab();
  await waitFor(() => expect(tab("Settled").getAttribute("aria-selected")).toBe("true"));
  expect(thumb()?.getAttribute("data-selected-index")).toBe("2");

  await nextTab();
  await waitFor(() => expect(tab("Inbox").getAttribute("aria-selected")).toBe("true"));
  expect(thumb()?.getAttribute("data-selected-index")).toBe("0");
});

test("a rebound shortcut works and its tooltip shows the new key", async () => {
  await openHome();
  setKeybindingOverrides({ showSnoozed: "alt+shift+8" });

  await userEvent.keyboard("{Alt>}{Shift>}8{/Shift}{/Alt}");
  await waitFor(() => expect(tab("Snoozed").getAttribute("aria-selected")).toBe("true"));

  await userEvent.hover(tab("Snoozed"));
  const tooltip = await screen.findByRole("tooltip");
  expect(tooltip.textContent).toContain("Snoozed");
  expect(tooltip.textContent).toContain("Alt+Shift+8");
});
