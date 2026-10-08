import { failingSubagent, longHistory } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const title = (name: string) => screen.findByRole("heading", { level: 1, name });
const threadList = () => screen.queryByRole("complementary", { name: "Threads" });
const button = (name: string) => screen.getByRole<HTMLButtonElement>("button", { name });

test("every view and settings page opens in the shell under its own title", async () => {
  const pages: [string, string][] = [
    ["/", "Home"],
    ["/new", "New thread"],
    ["/activity", "Activity"],
    ["/offsets", "Offsets"],
    ["/offsets/new", "New offset"],
    ["/automations", "Automations"],
    ["/skills", "Skills"],
    ["/accounts", "Usage & accounts"],
    ["/settings", "Settings"],
  ];
  for (const [path, name] of pages) {
    const view = await harness().open(path);
    await title(name);
    expect(screen.getByRole("navigation", { name: "App" })).toBeTruthy();
    view.unmount();
  }
  await harness().open("/settings");
  await screen.findByRole("heading", { level: 2, name: "General" });
  const pagesNav = screen.getByRole("navigation", { name: "Settings pages" });
  for (const page of [
    "Appearance",
    "Providers",
    "Notifications",
    "Remote devices",
    "Keyboard",
    "Advanced",
  ]) {
    await userEvent.click(within(pagesNav).getByRole("link", { name: page }));
    await screen.findByRole("heading", { level: 2, name: page });
  }
  await userEvent.click(within(pagesNav).getByRole("link", { name: "Appearance" }));
  await userEvent.click(await screen.findByRole("link", { name: "Open theme editor" }));
  await screen.findByRole("heading", { level: 2, name: "Theme editor" });
});

test("old addresses land where their pages live now", async () => {
  for (const [path, name] of [
    ["/deck", "Offsets"],
    ["/deck/new", "New offset"],
    ["/more", "Usage & accounts"],
    ["/more/accounts", "Usage & accounts"],
    ["/more/files", "Home"],
  ] as const) {
    const view = await harness().open(path);
    await title(name);
    view.unmount();
  }
  // An old search address opens the search dialog with its words, over Home.
  await harness().open("/more/search?q=retry%20budget");
  const dialog = await screen.findByRole("dialog", { name: "Search" });
  expect(
    within(dialog).getByRole<HTMLInputElement>("combobox", { name: "Search every thread" }).value,
  ).toBe("retry budget");
  await userEvent.keyboard("{Escape}");
  await title("Home");
});

test("the sidebar marks the current view and the header's back and forward follow history", async () => {
  await harness().open("/");
  await title("Home");
  const views = screen.getByRole("navigation", { name: "App" });
  expect(button("Back").disabled).toBe(true);
  expect(button("Forward").disabled).toBe(true);

  await userEvent.click(within(views).getByRole("link", { name: "Offsets" }));
  await title("Offsets");
  expect(within(views).getByRole("link", { name: "Offsets" }).getAttribute("aria-current")).toBe(
    "page",
  );
  expect(button("Back").disabled).toBe(false);

  await userEvent.click(button("Back"));
  await title("Home");
  expect(button("Back").disabled).toBe(true);
  expect(button("Forward").disabled).toBe(false);

  await userEvent.keyboard("{Meta>}]{/Meta}");
  await title("Offsets");
  expect(button("Forward").disabled).toBe(true);
});

test("⌘\\ hides the sidebar and the header offers to bring it back", async () => {
  const app = harness();
  app.play(longHistory(2)).runUntilBlocked();
  await app.open("/");
  await screen.findByRole("complementary", { name: "Threads" });
  expect(screen.queryByRole("button", { name: "Show sidebar" })).toBeNull();

  await userEvent.keyboard("{Meta>}\\{/Meta}");
  await waitFor(() => expect(threadList()).toBeNull());
  await userEvent.click(button("Show sidebar"));
  expect(threadList()).toBeTruthy();
});

test("G then A jumps to Activity, but not while typing", async () => {
  await harness().open("/");
  await title("Home");
  await userEvent.keyboard("{Meta>}k{/Meta}");
  const search = await screen.findByRole("combobox", { name: "Search commands" });
  await userEvent.type(search, "ga");
  expect(screen.queryByRole("heading", { level: 1, name: "Activity" })).toBeNull();
  await userEvent.keyboard("{Escape}");

  await userEvent.keyboard("ga");
  await title("Activity");
});

test("⌘K finds a thread by title and opens it", async () => {
  const app = harness();
  app.play(failingSubagent()).step();
  await app.open("/");
  await userEvent.keyboard("{Meta>}k{/Meta}");
  const dialog = await screen.findByRole("dialog", { name: "Command palette" });
  await userEvent.type(within(dialog).getByRole("combobox"), "Migrate settings");
  await userEvent.keyboard("{Enter}");
  await title("Migrate settings schema");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull());
});
