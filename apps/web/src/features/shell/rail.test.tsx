import {
  facts,
  flakyCheckout,
  workbench,
  workbenchServices,
  type Scenario,
} from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

const title = (name: string) => screen.findByRole("heading", { level: 1, name });
const rail = () => screen.getByRole("navigation", { name: "Views" });
const button = (name: string) => screen.getByRole("button", { name });
/** The view's own list in the sidebar's body (the thread list on Home). */
const list = (name: string) => screen.queryByRole("complementary", { name });

function workbenchApp(storage = memoryKeyValue()) {
  const app = harness({ storage });
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.seedServices(workbenchServices(Date.now()));
  return app;
}

/** The sidebar's own links and buttons: "ace ▾", Activity, Search and commands, New thread. */
const appNav = () => screen.getByRole("navigation", { name: "App" });

test("each rail icon opens its view, marks it, and puts that view's list in the sidebar", async () => {
  await harness().open("/new");
  await title("New thread");
  expect(list("Threads")).toBeTruthy();
  for (const [icon, heading, listName] of [
    ["Deck", "Deck", "Decks"],
    ["Automations", "Automations", "Automations"],
    ["Skills", "Skills", "Skills"],
    ["Home", "Home", "Threads"],
  ] as const) {
    const link = within(rail()).getByRole("link", { name: icon });
    await userEvent.click(link);
    await title(heading);
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(list(listName)).toBeTruthy();
  }
  await userEvent.click(within(rail()).getByRole("link", { name: "Settings" }));
  await title("Settings");
  expect(within(rail()).getByRole("link", { name: "Settings" }).getAttribute("aria-current")).toBe(
    "page",
  );
  expect(screen.getByRole("navigation", { name: "Settings pages" })).toBeTruthy();

  await userEvent.click(within(appNav()).getByRole("link", { name: "Activity" }));
  await title("Activity");
  expect(list("Activity")).toBeTruthy();
  // One link per place marks it current: Activity is the bell, not a rail icon too.
  expect(screen.getAllByRole("link", { current: "page" })).toEqual([
    within(appNav()).getByRole("link", { name: "Activity" }),
  ]);
});

test("a rail icon's tooltip names it with its shortcut, on hover and on keyboard focus", async () => {
  await harness().open("/new");
  await title("New thread");
  await userEvent.hover(within(rail()).getByRole("link", { name: "Deck" }));
  const hovered = await screen.findByRole("tooltip");
  // A sequence reads as keys one after another.
  expect(hovered.textContent).toBe("DeckGthenD");
  await userEvent.unhover(within(rail()).getByRole("link", { name: "Deck" }));
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());

  within(rail()).getByRole("link", { name: "Skills" }).focus();
  const focused = await screen.findByRole("tooltip");
  expect(focused.textContent).toBe("SkillsGthenS");
});

test("what needs you is counted on the sidebar's bell, not on the rail", async () => {
  await workbenchApp().open("/activity");
  await title("Activity");
  const bell = await within(appNav()).findByRole("link", { name: "Activity, 6 need you" });
  expect(within(bell).getByLabelText("6 need you")).toBeTruthy();
  expect(within(rail()).queryByRole("link", { name: /need/ })).toBeNull();
});

/** A thread that works a turn and finishes, never opened on this device. */
const finishes: Scenario = {
  thread: {
    id: "thread-report",
    workspaceId: "relay",
    title: "Write the weekly report",
    provider: "claude",
  },
  steps: [
    {
      kind: "facts",
      label: "done",
      facts: [facts.rootAgent("claude"), facts.turn("root"), facts.endTurn("root")],
    },
  ],
};

test("a thread that finishes after launch, never opened, is news on the rail and in Home alike", async () => {
  // The daemon's clock runs a minute ahead of this device's first launch.
  const app = harness({ clock: () => Date.now() + 60_000 });
  await app.open("/new");
  await title("New thread");
  expect(within(rail()).getByRole("link", { name: "Home" })).toBeTruthy();
  app.play(finishes).runUntilBlocked();
  expect(await within(rail()).findByRole("link", { name: "Home, new activity" })).toBeTruthy();
  const threads = screen.getByRole("navigation", { name: "Threads" });
  expect(
    await within(threads).findByRole("link", { name: /^Write the weekly report, unread/ }),
  ).toBeTruthy();
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

test("the account on the rail is named by its tooltip too", async () => {
  await harness().open("/new");
  await title("New thread");
  await userEvent.hover(screen.getByRole("button", { name: "Account and connection" }));
  expect((await screen.findByRole("tooltip")).textContent).toBe("Account and connection");
});

test("More on the rail is a menu of usage and accounts, files and search, and opens no second sidebar", async () => {
  await harness().open("/new");
  await title("New thread");
  for (const [item, heading] of [
    ["Files", "Files"],
    ["Usage & accounts", "Usage & accounts"],
    ["Search", "Search"],
  ] as const) {
    await userEvent.click(within(rail()).getByRole("button", { name: "More" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: item }));
    await title(heading);
    // The one sidebar keeps the thread list; More never swaps in a list of its own.
    expect(screen.getByRole("complementary", { name: "Threads" })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "More" })).toBeNull();
  }
});

const more = () => within(rail()).getByRole("button", { name: "More" });

test("the rail's More menu closes on Escape or a click outside, and its items go from the keyboard", async () => {
  await harness().open("/new");
  await title("New thread");
  await userEvent.click(more());
  const menu = await screen.findByRole("menu");
  expect(
    within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent),
  ).toEqual(["Usage & accounts", "Files", "Search"]);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(document.activeElement).toBe(more());

  await userEvent.click(more());
  await screen.findByRole("menu");
  await userEvent.click(screen.getByRole("heading", { level: 1, name: "New thread" }));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

  await userEvent.click(more());
  await screen.findByRole("menu");
  await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
  await title("Files");
});

test("the sidebar's title is the daemon's menu, and the avatar the person's", async () => {
  await harness().open("/new");
  await title("New thread");
  await userEvent.click(button("ace menu"));
  const daemon = await screen.findByRole("menu");
  expect(within(daemon).getByText(/Connected$/)).toBeTruthy();
  await userEvent.click(within(daemon).getByRole("menuitem", { name: "Pair a device…" }));
  await screen.findByRole("heading", { level: 2, name: "Remote devices" });

  await userEvent.click(button("Account and connection"));
  const account = await screen.findByRole("menu");
  const items = within(account)
    .getAllByRole("menuitem")
    .map((item) => item.textContent);
  expect(items).toEqual(["SettingsCtrl+,", "Appearance", "Keyboard shortcuts", "Usage & accounts"]);
  await userEvent.click(within(account).getByRole("menuitem", { name: "Keyboard shortcuts" }));
  await screen.findByRole("heading", { level: 2, name: "Keyboard" });
});

test("the sidebar's bell and Search and commands are one click away", async () => {
  await harness().open("/new");
  await title("New thread");
  await userEvent.click(within(appNav()).getByRole("link", { name: "Activity" }));
  await title("Activity");
  await userEvent.click(button("Search and commands"));
  expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeTruthy();
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
  ] as const) {
    await userEvent.keyboard(keys);
    await title(heading);
  }
});

test("⌘\\ hides the sidebar but never the rail, and the choice survives a reload", async () => {
  const storage = memoryKeyValue();
  const view = await harness({ storage }).open("/new");
  await title("New thread");
  await userEvent.keyboard("{Meta>}\\{/Meta}");
  await waitFor(() => expect(list("Threads")).toBeNull());
  expect(within(rail()).getByRole("link", { name: "Home" })).toBeTruthy();
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

  await userEvent.click(button("Search and commands"));
  const create = within(await screen.findByRole("group", { name: "Create" }));
  const options = create.getAllByRole("option");
  expect(options[0]?.textContent).toMatch(/^Add project…/);
  const newThread = create.getByRole("option", { name: /^New thread/ });
  expect(newThread.getAttribute("aria-disabled")).toBe("true");
  expect(newThread.textContent).toContain("Add a project first");
});
