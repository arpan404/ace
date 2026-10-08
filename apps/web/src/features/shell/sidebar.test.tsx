import { flakyCheckout, workbench, workbenchServices } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

const title = (name: string) => screen.findByRole("heading", { level: 1, name });
const button = (name: string | RegExp) => screen.getByRole("button", { name });
/** A list on screen: the thread list in the sidebar, or a view's own beside its column. */
const list = (name: string) => screen.queryByRole("complementary", { name });
/** The sidebar's own links and buttons: "ace ▾", Search, Activity, New thread and the places. */
const appNav = () => screen.getByRole("navigation", { name: "App" });

function workbenchApp(storage = memoryKeyValue()) {
  const app = harness({ storage });
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.seedServices(workbenchServices(Date.now()));
  return app;
}

test("the sidebar's places open their views, mark them, and keep the thread list beside", async () => {
  await workbenchApp().open("/new");
  await title("New thread");
  // One sidebar: no rail of views beside it.
  expect(screen.queryByRole("navigation", { name: "Views" })).toBeNull();
  for (const place of ["Offshifts", "Automations", "Skills"]) {
    const link = within(appNav()).getByRole("link", { name: place });
    await userEvent.click(link);
    // The view's own list sits beside its column; the sidebar still lists the threads.
    expect(await screen.findByRole("complementary", { name: place })).toBeTruthy();
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(list("Threads")).toBeTruthy();
  }
  // One of the sidebar's places is current at a time.
  expect(within(appNav()).getAllByRole("link", { current: "page" })).toEqual([
    within(appNav()).getByRole("link", { name: "Skills" }),
  ]);

  await userEvent.click(within(appNav()).getByRole("link", { name: /^New thread/ }));
  await title("New thread");
  expect(within(appNav()).getAllByRole("link", { current: "page" })).toEqual([
    within(appNav()).getByRole("link", { name: /^New thread/ }),
  ]);
});

test("Settings is the gear beside the profile, and its pages take the thread list's place", async () => {
  await harness().open("/new");
  await title("New thread");
  const gear = screen.getByRole("link", { name: "Settings" });
  await userEvent.click(gear);
  await title("Settings");
  expect(gear.getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("navigation", { name: "Settings pages" })).toBeTruthy();
  expect(list("Threads")).toBeNull();

  await userEvent.click(within(appNav()).getByRole("link", { name: "Offshifts" }));
  await title("Offshifts");
  expect(await screen.findByRole("complementary", { name: "Threads" })).toBeTruthy();
});

test("the bell counts what needs you and opens Activity, its feed beside the column", async () => {
  await workbenchApp().open("/new");
  await title("New thread");
  const bell = await within(appNav()).findByRole("link", { name: "Activity, 6 need you" });
  expect(within(bell).getByLabelText("6 need you")).toBeTruthy();
  await userEvent.click(bell);
  await title("Activity");
  expect(bell.getAttribute("aria-current")).toBe("page");
  expect(list("Activity")).toBeTruthy();
  expect(list("Threads")).toBeTruthy();
});

test("the bell's count follows a thread that comes to need you, through the client worker too", async () => {
  const worker = harness({ throughWorker: true });
  const checkout = worker.play(flakyCheckout());
  checkout.runThrough("watcher-started");
  await worker.open("/new");
  await title("New thread");
  expect(await within(appNav()).findByRole("link", { name: "Activity" })).toBeTruthy();
  checkout.runThrough("approval-requested");
  expect(await within(appNav()).findByRole("link", { name: "Activity, 1 needs you" })).toBeTruthy();
});

test("the sidebar's title is the daemon's menu, and the profile at its foot the person's", async () => {
  await harness().open("/new");
  await title("New thread");
  await userEvent.click(button("ace menu"));
  const daemon = await screen.findByRole("menu");
  expect(within(daemon).getByText(/Connected$/)).toBeTruthy();
  await userEvent.click(within(daemon).getByRole("menuitem", { name: "Pair a device…" }));
  await screen.findByRole("heading", { level: 2, name: "Remote devices" });

  const profile = button(/^You, account/);
  expect(profile.textContent).toBe("You");
  await userEvent.click(profile);
  const account = await screen.findByRole("menu");
  // Settings is the gear beside the profile, so the menu doesn't repeat it.
  expect(
    within(account)
      .getAllByRole("menuitem")
      .map((item) => item.textContent),
  ).toEqual(["Appearance", "Keyboard shortcuts", "Usage & accounts"]);
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
    ["gd", "Offshifts"],
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
  await harness().open("/activity");
  await title("Activity");
  const add = await within(appNav()).findByRole("button", { name: /^Add project/ });
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
