import { workbench, workbenchServices } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

const title = (name: string) => screen.findByRole("heading", { level: 1, name });
const views = () => screen.getByRole("navigation", { name: "Views" });
const button = (name: string) => screen.getByRole("button", { name });
/** The view's own list in the sidebar's body (the thread list on Home). */
const list = (name: string) => screen.queryByRole("complementary", { name });

function workbenchApp(storage = memoryKeyValue()) {
  const app = harness({ storage });
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.seedServices(workbenchServices(Date.now()));
  return app;
}

test("each row opens its view, marks it, and puts that view's list in the sidebar", async () => {
  await harness().open("/new");
  await title("New thread");
  expect(list("Threads")).toBeTruthy();
  for (const [row, heading, listName] of [
    ["Activity", "Activity", "Activity"],
    ["Deck", "Deck", "Decks"],
    ["Automations", "Automations", "Automations"],
    ["Skills", "Skills", "Skills"],
  ] as const) {
    const link = within(views()).getByRole("link", { name: new RegExp(`^${row}`) });
    await userEvent.click(link);
    await title(heading);
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(list(listName)).toBeTruthy();
    expect(list("Threads")).toBeNull();
  }
  await userEvent.click(screen.getByRole("link", { name: "Settings" }));
  await title("Settings");
  expect(screen.getByRole("link", { name: "Settings" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("navigation", { name: "Settings pages" })).toBeTruthy();

  await userEvent.click(screen.getByRole("link", { name: /^New thread/ }));
  await title("New thread");
  expect(list("Threads")).toBeTruthy();
});

test("More holds usage and accounts, files and search", async () => {
  await harness().open("/new");
  await title("New thread");
  await userEvent.click(within(views()).getByRole("button", { name: "More" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Files" }));
  await title("Files");

  await userEvent.click(within(views()).getByRole("button", { name: "More" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Usage & accounts" }));
  await title("Usage & accounts");

  await userEvent.click(within(views()).getByRole("button", { name: "More" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Search" }));
  await title("Search");
});

test("every view's shortcut opens it from anywhere", async () => {
  await harness().open("/new");
  await title("New thread");
  for (const [keys, heading] of [
    ["gd", "Deck"],
    ["gu", "Automations"],
    ["gs", "Skills"],
    ["ga", "Activity"],
    ["{Meta>},{/Meta}", "Settings"],
    ["gh", "Home"],
    ["{Meta>}n{/Meta}", "New thread"],
  ] as const) {
    await userEvent.keyboard(keys);
    await title(heading);
  }
});

test("the threads' Add project button opens Add project", async () => {
  await harness().open("/new");
  await userEvent.click(await screen.findByRole("button", { name: "Add project" }));
  expect(await screen.findByRole("dialog", { name: "Add project" })).toBeTruthy();
});

test("as icons the sidebar keeps every view, its count and its name, and stays so after a reload", async () => {
  const storage = memoryKeyValue();
  const view = await workbenchApp(storage).open("/activity");
  await title("Activity");
  expect(await within(views()).findByLabelText("6 need you")).toBeTruthy();

  await userEvent.click(button("Collapse sidebar"));
  await waitFor(() => expect(list("Activity")).toBeNull());
  // The keyboard stays on the switch, now at the foot of the column.
  expect(document.activeElement).toBe(button("Expand sidebar"));
  // The rows are icons now: each still says what it is, the count included.
  expect(within(views()).getByRole("link", { name: "Activity, 6 need you" })).toBeTruthy();
  const deck = within(views()).getByRole("link", { name: "Deck" });
  await userEvent.hover(deck);
  // Its tooltip names it, with its shortcut.
  const tip = await screen.findByRole("tooltip");
  expect(within(tip).getByText("Deck")).toBeTruthy();
  expect(within(tip).getByText("G D")).toBeTruthy();
  await userEvent.click(deck);
  await screen.findByRole("complementary", { hidden: true, name: "Decks" });
  expect(within(views()).getByRole("link", { name: "Deck" }).getAttribute("aria-current")).toBe(
    "page",
  );
  for (const row of ["Automations", "Skills"]) {
    await userEvent.click(within(views()).getByRole("link", { name: row }));
    // The view's list is there, hidden while the sidebar is icons.
    await screen.findByRole("complementary", { hidden: true, name: row });
    expect(within(views()).getByRole("link", { name: row }).getAttribute("aria-current")).toBe(
      "page",
    );
  }
  await userEvent.click(within(views()).getByRole("button", { name: "More" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Files" }));
  await title("Files");
  await userEvent.click(screen.getByRole("link", { name: "Settings" }));
  await title("Settings");
  await userEvent.click(screen.getByRole("link", { name: /^New thread/ }));
  await title("New thread");
  expect(list("Threads")).toBeNull();
  view.unmount();

  // The choice is this device's layout: it comes back with the app.
  await workbenchApp(storage).open("/activity");
  await title("Activity");
  expect(list("Activity")).toBeNull();
  await userEvent.click(button("Expand sidebar"));
  expect(await screen.findByRole("complementary", { name: "Activity" })).toBeTruthy();
  expect(within(views()).getByRole("link", { name: /^Activity/ }).textContent).toContain(
    "Activity",
  );
});

test("as icons the wordmark still goes Home", async () => {
  await harness().open("/activity");
  await title("Activity");
  await userEvent.click(button("Collapse sidebar"));
  await userEvent.click(screen.getByRole("link", { name: "Home" }));
  await title("Home");
  expect(button("Expand sidebar")).toBeTruthy();
});

test("⌘\\ hides the sidebar, icons or not, and brings back the same one", async () => {
  await harness().open("/new");
  await title("New thread");
  await userEvent.click(button("Collapse sidebar"));
  await userEvent.keyboard("{Meta>}\\{/Meta}");
  await waitFor(() => expect(screen.queryByRole("navigation", { name: "Views" })).toBeNull());

  await userEvent.click(button("Show sidebar"));
  expect(views()).toBeTruthy();
  expect(button("Expand sidebar")).toBeTruthy();
  expect(list("Threads")).toBeNull();
});
