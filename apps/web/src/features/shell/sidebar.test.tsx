import { openProfileMenu, openProfileView } from "@/test/navigation.ts";
import { workbench, workbenchServices } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

const title = (name: string) => screen.findByRole("heading", { level: 1, name });
const button = (name: string | RegExp) => screen.getByRole("button", { name });
/** The list in the sidebar for the current place. */
const list = (name: string) => screen.queryByRole("complementary", { name });
/** The sidebar's own links and buttons: "ace ▾", Search, New thread and the places. */
const appNav = () => screen.getByRole("navigation", { name: "App" });

function workbenchApp(storage = memoryKeyValue()) {
  const app = harness({ storage });
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.seedServices(workbenchServices(Date.now()));
  return app;
}

test("profile views replace app navigation and return to the thread list", async () => {
  await workbenchApp().open("/new");
  await title("New thread");
  expect(screen.queryByRole("navigation", { name: "Views" })).toBeNull();
  for (const place of ["Automations", "Skills"] as const) {
    expect(within(appNav()).queryByRole("link", { name: place })).toBeNull();
    await openProfileView(place);
    expect(await screen.findByRole("complementary", { name: place })).toBeTruthy();
    expect(list("Threads")).toBeNull();
    expect(screen.queryByRole("button", { name: "ace menu" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^You, account/ })).toBeNull();
    expect(within(appNav()).queryByRole("link", { name: /^New thread/ })).toBeNull();
    await userEvent.click(screen.getByRole("link", { name: "Back to app" }));
    await title("New thread");
    expect(list("Threads")).toBeTruthy();
    expect(button(/^You, account/)).toBeTruthy();
  }
});

test("Settings hides app navigation and returns through Back to app", async () => {
  await harness().open("/new");
  await title("New thread");
  const gear = screen.getByRole("link", { name: "Settings" });
  await userEvent.click(gear);
  await title("Settings");
  expect(screen.queryByRole("button", { name: "ace menu" })).toBeNull();
  expect(within(appNav()).queryByRole("button", { name: "Search" })).toBeNull();
  expect(screen.queryByRole("heading", { level: 2, name: "Settings" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^You, account/ })).toBeNull();
  for (const name of [/^New thread/, /^Add project/, "Automations", "Skills"]) {
    expect(within(appNav()).queryByRole("link", { name })).toBeNull();
    expect(within(appNav()).queryByRole("button", { name })).toBeNull();
  }
  expect(screen.getByRole("navigation", { name: "Settings pages" })).toBeTruthy();
  expect(list("Threads")).toBeNull();

  await userEvent.click(screen.getByRole("link", { name: "Back to app" }));
  await title("New thread");
  expect(screen.queryByRole("link", { name: "Back to app" })).toBeNull();
  expect(within(appNav()).queryByRole("link", { name: "Automations" })).toBeNull();
  expect(screen.getByRole("link", { name: "Settings" })).toBeTruthy();
  expect(button(/^You, account/)).toBeTruthy();
  expect(list("Threads")).toBeTruthy();
});

test("the sidebar's title is the daemon's menu, and the profile at its foot the person's", async () => {
  await harness().open("/new");
  await title("New thread");
  await userEvent.click(button("ace menu"));
  const daemon = await screen.findByRole("menu");
  expect(within(daemon).getByText(/Connected$/)).toBeTruthy();
  await userEvent.click(within(daemon).getByRole("menuitem", { name: "Pair a device…" }));
  await screen.findByRole("heading", { level: 2, name: "Remote devices" });
  await userEvent.click(screen.getByRole("link", { name: "Back to app" }));
  await title("New thread");

  const profile = button(/^You, account/);
  expect(profile.textContent).toBe("You");
  const account = await openProfileMenu();
  // Settings is the gear beside the profile, so the menu doesn't repeat it.
  expect(
    within(account)
      .getAllByRole("menuitem")
      .map((item) => item.textContent),
  ).toEqual([
    "Automations",
    "Skills",
    "Appearance",
    "Keyboard shortcuts",
    "Usage & accounts",
    "Archived threads",
  ]);
  await userEvent.click(within(account).getByRole("menuitem", { name: "Usage & accounts" }));
  await title("Usage & accounts");
  expect(list("Threads")).toBeTruthy();
});

test("the profile menu closes on Escape and gives focus back to the profile", async () => {
  await harness().open("/new");
  await title("New thread");
  const profile = button(/^You, account/);
  await userEvent.click(profile);
  await screen.findByRole("menu");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(document.activeElement).toBe(button(/^You, account/));
});

test("Search in the sidebar opens the search dialog over the current screen", async () => {
  await harness().open("/new");
  await title("New thread");
  await userEvent.click(within(appNav()).getByRole("button", { name: "Search" }));
  const dialog = await screen.findByRole("dialog", { name: "Search" });
  // Focus lands in its field, ready to type.
  await waitFor(() =>
    expect(within(dialog).getByRole("combobox", { name: "Search every thread" })).toBe(
      document.activeElement,
    ),
  );
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull());
  expect(screen.getByRole("heading", { level: 1, name: "New thread" })).toBeTruthy();
});

test("every view's shortcut opens it from anywhere", async () => {
  await harness().open("/new");
  await title("New thread");
  for (const [keys, heading] of [
    ["gu", "Automations"],
    ["gs", "Skills"],
    ["ga", "Activity"],
    ["{Meta>},{/Meta}", "Settings"],
    ["gh", "Home"],
  ] as const) {
    await userEvent.keyboard(keys);
    await title(heading);
  }
});

test("⌘\\ hides the sidebar, and the choice survives a reload", async () => {
  const storage = memoryKeyValue();
  const view = await harness({ storage }).open("/new");
  await title("New thread");
  await userEvent.keyboard("{Meta>}\\{/Meta}");
  await waitFor(() => expect(list("Threads")).toBeNull());
  expect(screen.queryByRole("navigation", { name: "App" })).toBeNull();
  view.unmount();

  await harness({ storage }).open("/new");
  await title("New thread");
  expect(list("Threads")).toBeNull();
  await userEvent.click(button("Show sidebar"));
  expect(await screen.findByRole("complementary", { name: "Threads" })).toBeTruthy();
});

test("with no project yet, the sidebar, ⌘N and the palette all lead to Add project", async () => {
  await harness().open("/new");
  await title("New thread");
  const add = await within(
    await screen.findByRole("complementary", { name: "Threads" }),
  ).findByRole("button", { name: /^Add project/ });
  expect(screen.queryByRole("button", { name: /^Project filter:/ })).toBeNull();
  expect(within(appNav()).queryByRole("link", { name: /^New thread/ })).toBeNull();
  await userEvent.click(add);
  expect(await screen.findByRole("dialog", { name: "Add project" })).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add project" })).toBeNull());

  await userEvent.keyboard("{Control>}n{/Control}");
  expect(await screen.findByRole("dialog", { name: "Add project" })).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add project" })).toBeNull());

  await userEvent.keyboard("{Meta>}k{/Meta}");
  const create = within(await screen.findByRole("group", { name: "Create" }));
  const options = create.getAllByRole("option");
  expect(options[0]?.textContent).toMatch(/^Add project…/);
  const newThread = create.getByRole("option", { name: /^New thread/ });
  expect(newThread.getAttribute("aria-disabled")).toBe("true");
  expect(newThread.textContent).toContain("Add a project first");
});
