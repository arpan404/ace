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

test("each rail icon opens its view, marks it, and puts that view's list in the sidebar", async () => {
  await harness().open("/new");
  await title("New thread");
  expect(list("Threads")).toBeTruthy();
  for (const [icon, heading, listName] of [
    ["Activity", "Activity", "Activity"],
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

  await userEvent.click(screen.getByRole("link", { name: /^New thread/ }));
  await title("New thread");
  expect(list("Threads")).toBeTruthy();
});

test("a rail icon's tooltip names it with its shortcut, on hover and on keyboard focus", async () => {
  await harness().open("/new");
  await title("New thread");
  await userEvent.hover(within(rail()).getByRole("link", { name: "Deck" }));
  const hovered = await screen.findByRole("tooltip");
  expect(within(hovered).getByText("Deck")).toBeTruthy();
  expect(within(hovered).getByText("G D")).toBeTruthy();
  await userEvent.unhover(within(rail()).getByRole("link", { name: "Deck" }));
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());

  within(rail()).getByRole("link", { name: "Skills" }).focus();
  const focused = await screen.findByRole("tooltip");
  expect(within(focused).getByText("Skills")).toBeTruthy();
  expect(within(focused).getByText("G S")).toBeTruthy();
});

test("the rail's Home carries a dot while a thread needs you, and Activity its count", async () => {
  await workbenchApp().open("/activity");
  await title("Activity");
  expect(
    await within(rail()).findByRole("link", { name: "Home, a thread needs you" }),
  ).toBeTruthy();
  expect(within(rail()).getByRole("link", { name: "Activity, 6 need you" })).toBeTruthy();
  expect(within(rail()).getByLabelText("6 need you")).toBeTruthy();
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

test("Home's dot follows a thread that comes to need you, through the client worker too", async () => {
  const app = harness({ throughWorker: true });
  const checkout = app.play(flakyCheckout());
  checkout.runThrough("watcher-started");
  await app.open("/new");
  await title("New thread");
  expect(await within(rail()).findByRole("link", { name: "Home" })).toBeTruthy();
  checkout.runThrough("approval-requested");
  expect(
    await within(rail()).findByRole("link", { name: "Home, a thread needs you" }),
  ).toBeTruthy();
});

test("the account on the rail is named by its tooltip too", async () => {
  await harness().open("/new");
  await title("New thread");
  await userEvent.hover(screen.getByRole("button", { name: "Account and connection" }));
  expect((await screen.findByRole("tooltip")).textContent).toBe("Account and connection");
});

test("More on the rail holds usage and accounts, files and search", async () => {
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
  }
});

test("the sidebar's title opens the account menu, and its bell and search are one click away", async () => {
  await harness().open("/new");
  await title("New thread");
  await userEvent.click(button("ace menu"));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Usage & accounts" }));
  await title("Usage & accounts");

  // The sidebar's own bell, beside the rail's Activity.
  const bells = screen.getAllByRole("link", { name: "Activity" });
  expect(bells).toHaveLength(2);
  const bell = bells.find((link) => !rail().contains(link));
  if (!bell) throw new Error("The sidebar has no bell of its own");
  await userEvent.click(bell);
  await title("Activity");
  await userEvent.click(button("Search"));
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
    ["{Meta>}n{/Meta}", "New thread"],
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
