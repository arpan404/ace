import { openProfileMenu } from "@/test/navigation.ts";
import { longHistory, workbench, workbenchServices } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { createMemoryHistory } from "@tanstack/react-router";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";
import { createIdleTask } from "@/test/tasks.ts";

const title = (name: string) => screen.findByRole("heading", { level: 1, name });
const button = (name: string | RegExp) => screen.getByRole("button", { name });
/** The list in the sidebar for the current place. */
const list = (name: string) => screen.queryByRole("complementary", { name });
/** The sidebar's rail: its places, Settings and the profile. */
const appNav = () => screen.getByRole("navigation", { name: "App" });
/** The view's header: back, forward and the sidebar toggle at its far left. */
const header = () => within(screen.getByRole("banner"));

function workbenchApp(storage = memoryKeyValue()) {
  const app = harness({ storage });
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.seedServices(workbenchServices(Date.now()));
  return app;
}

/** A profile view's own list in the sidebar: the automations, or the skills catalog. */
const ownList = {
  Automations: (sidebar: HTMLElement) =>
    within(sidebar).findByRole("navigation", { name: "Automation list" }),
  Skills: (sidebar: HTMLElement) =>
    within(sidebar).findByRole("navigation", { name: "Skills catalog" }),
} as const;
/** The page each view opens on in the workbench: Automations opens its first automation. */
const landing = { Automations: "Nightly dependency audit", Skills: "Skills" } as const;

/** A place in the rail. */
const place = (name: string | RegExp) => within(appNav()).getByRole("link", { name });

test("the rail's places stay on screen across Automations and Skills, with no Back to app", async () => {
  await workbenchApp().open("/new");
  await title("New thread");
  expect(place(/^Threads/).getAttribute("aria-current")).toBe("page");
  for (const name of ["Automations", "Skills"] as const) {
    await userEvent.click(place(name));
    await title(landing[name]);
    // Its own list in the panel under its own heading, never Settings' pages around it.
    const sidebar = await screen.findByRole("complementary", { name });
    expect(within(sidebar).getByRole("heading", { level: 2, name })).toBeTruthy();
    expect(await ownList[name](sidebar)).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Settings pages" })).toBeNull();
    expect(list("Threads")).toBeNull();
    // The rail stays: every place, Settings and the profile, the current one marked.
    expect(place(name).getAttribute("aria-current")).toBe("page");
    expect(place(/^Threads/).getAttribute("aria-current")).toBeNull();
    for (const other of [/^Code review/, "Settings"]) expect(place(other)).toBeTruthy();
    expect(within(appNav()).getByRole("button", { name: /^You, account/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Back to app" })).toBeNull();
    await userEvent.click(place(/^Threads/));
    await title("New thread");
    expect(list("Threads")).toBeTruthy();
  }
});

test("Settings keeps the rail and lists only its own pages in the panel", async () => {
  await harness().open("/new");
  await title("New thread");
  await userEvent.click(place("Settings"));
  await title("Settings");
  expect(place("Settings").getAttribute("aria-current")).toBe("page");
  for (const name of [/^Threads/, /^Code review/, "Automations", "Skills"])
    expect(place(name)).toBeTruthy();
  expect(within(appNav()).getByRole("button", { name: /^You, account/ })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Back to app" })).toBeNull();
  expect(screen.getByRole("navigation", { name: "Settings pages" })).toBeTruthy();
  expect(list("Threads")).toBeNull();
  // The panel lists Settings' pages only: Automations and Skills are places of their own.
  const sidebar = screen.getByRole("complementary", { name: "Settings" });
  for (const name of ["Automations", "Skills"]) {
    expect(within(sidebar).queryByRole("link", { name })).toBeNull();
    expect(within(sidebar).queryByRole("complementary", { name })).toBeNull();
  }
  await userEvent.click(place(/^Threads/));
  await title("New thread");
  expect(list("Threads")).toBeTruthy();
});

test("Threads in the rail returns to the thread the person left, across Settings pages", async () => {
  const history = createMemoryHistory({ initialEntries: ["/t/thread-router"] });
  const app = harness({ history });
  app.play(longHistory(2)).runUntilBlocked();
  await app.open("/t/thread-router");
  await title("Document the router");
  await userEvent.click(place("Settings"));
  await title("Settings");
  await userEvent.click(
    within(screen.getByRole("navigation", { name: "Settings pages" })).getByRole("link", {
      name: "Appearance",
    }),
  );
  await screen.findByRole("heading", { name: "Appearance" });

  await userEvent.click(place(/^Threads/));
  await title("Document the router");
  expect(history.location.pathname).toBe("/t/thread-router");
});

test("Spade shows in the rail as coming soon, and is nothing to press", async () => {
  const history = createMemoryHistory({ initialEntries: ["/new"] });
  await harness({ history }).open("/new");
  await title("New thread");
  const spade = within(appNav()).getByRole("img", { name: "Spade, coming soon" });
  expect(spade.closest("a, button")).toBeNull();
  expect(spade.tabIndex).toBe(-1);
  expect(within(appNav()).queryByRole("link", { name: /Spade/ })).toBeNull();
  expect(within(appNav()).queryByRole("button", { name: /Spade/ })).toBeNull();
  await userEvent.click(spade);
  expect(history.location.pathname).toBe("/new");
  // Tabbing through the rail passes from Threads to Chats, then over Spade straight to GitHub.
  place("Threads").focus();
  await userEvent.tab();
  expect(document.activeElement).toBe(place(/^Chats/));
  await userEvent.tab();
  expect(document.activeElement).toBe(place(/^Code review/));
});

test("Threads in the rail says a thread needs the person only while they are elsewhere", async () => {
  await workbenchApp().open("/new");
  await title("New thread");
  // On Threads the list itself says so: the place carries no count.
  await screen.findByRole("complementary", { name: "Threads" });
  expect(place("Threads")).toBeTruthy();
  await userEvent.click(place("Settings"));
  await title("Settings");
  const threads = await within(appNav()).findByRole("link", { name: /^Threads, \d+ needs? you$/ });
  expect(threads.querySelector('[data-tone="needs-you"]')).toBeTruthy();
  await userEvent.click(threads);
  await title("New thread");
  expect(place("Threads").querySelector('[data-tone="needs-you"]')).toBeNull();
});

test("the profile menu holds the account and connection actions; Usage is a rail place", async () => {
  await harness().open("/new");
  await title("New thread");
  await openProfileMenu();
  await userEvent.click(await screen.findByRole("menuitem", { name: "Connection" }));
  const daemon = await screen.findByRole("menu", { name: "Connection" });
  expect(within(daemon).getByText(/Connected$/)).toBeTruthy();
  await userEvent.click(within(daemon).getByRole("menuitem", { name: "Pair a device…" }));
  await screen.findByRole("heading", { level: 2, name: "Fleet" });
  await userEvent.click(place(/^Threads/));
  await title("New thread");

  const account = await openProfileMenu();
  // Settings, Usage, Automations and Skills are places in the rail, so the menu doesn't repeat them.
  expect(
    within(account)
      .getAllByRole("menuitem")
      .map((item) => item.textContent),
  ).toEqual(["Archived threads", expect.stringMatching(/^Keyboard shortcuts/), "Connection"]);
  await userEvent.keyboard("{Escape}");
  await userEvent.click(place(/^Usage/));
  await title("Usage");
  expect(list("Threads")).toBeTruthy();
  // GitHub opens Pull requests first; its panel lists its three pages.
  await userEvent.click(place(/^Code review/));
  await title("Pull requests");
  const github = screen.getByRole("complementary", { name: "Code review" });
  expect(
    within(github)
      .getAllByRole("link")
      .map((link) => link.textContent),
  ).toEqual(["Inbox", "Pull requests", "Issues"]);
  expect(
    within(github).getByRole("link", { name: "Pull requests" }).getAttribute("aria-current"),
  ).toBe("page");
  await userEvent.click(within(github).getByRole("link", { name: "Issues" }));
  await title("Issues");
  expect(place(/^Code review/).getAttribute("aria-current")).toBe("page");
});

test("⌘K opens Automations and Skills as their own places, each with its list", async () => {
  await workbenchApp().open("/new");
  await title("New thread");
  for (const name of ["Automations", "Skills"] as const) {
    await userEvent.keyboard("{Meta>}k{/Meta}");
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    await userEvent.type(within(palette).getByRole("combobox", { name: "Search commands" }), name);
    await userEvent.click(
      await within(palette).findByRole("option", { name: new RegExp(`^${name}`) }),
    );
    await title(landing[name]);
    const sidebar = await screen.findByRole("complementary", { name });
    expect(await ownList[name](sidebar)).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Settings pages" })).toBeNull();
    expect(place(name).getAttribute("aria-current")).toBe("page");
    await userEvent.click(place(/^Threads/));
    await title("New thread");
  }
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

test("Search in the Threads title row opens a field in place, not the palette", async () => {
  await harness().open("/new");
  await title("New thread");
  // Row 1 is the title row again: Threads, then Search. Row 2 holds the All projects filter.
  const panel = screen.getByRole("complementary", { name: "Threads" });
  expect(within(panel).getByRole("heading", { level: 2, name: "Threads" })).toBeTruthy();
  const filter = within(panel).getByRole("button", { name: "Project filter: All projects" });
  expect(filter.textContent).toBe("All projects");
  const titleRow = within(panel)
    .getByRole("button", { name: "Search threads" })
    .closest('[data-slot="panel-top"]');
  expect(
    within(titleRow as HTMLElement).getByRole("heading", { level: 2, name: "Threads" }),
  ).toBeTruthy();
  expect(
    within(titleRow as HTMLElement).queryByRole("button", { name: /^Project filter/ }),
  ).toBeNull();
  await userEvent.click(within(panel).getByRole("button", { name: "Search threads" }));
  // Focus lands in its field, ready to type; the palette stays ⌘K's.
  const field = within(panel).getByRole("searchbox", { name: "Search threads" });
  await waitFor(() => expect(document.activeElement).toBe(field));
  expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  expect(screen.getByRole("heading", { level: 1, name: "New thread" })).toBeTruthy();
});

test("New thread is the pencil at the end of the filter row under the Threads title row", async () => {
  await workbenchApp().open("/new");
  await title("New thread");
  const panel = screen.getByRole("complementary", { name: "Threads" });
  // Row 1: Threads, then Search.
  expect(within(panel).getByRole("heading", { level: 2, name: "Threads" })).toBeTruthy();
  const search = within(panel).getByRole("button", { name: "Search threads" });
  const titleRow = search.closest('[data-slot="panel-top"]');
  if (!titleRow) throw new Error("No title row");
  expect(
    within(titleRow as HTMLElement).queryByRole("button", { name: /^Project filter/ }),
  ).toBeNull();
  expect(within(titleRow as HTMLElement).queryByRole("link", { name: "New thread" })).toBeNull();
  // Row 2: the All projects filter, then New thread.
  const filter = within(panel).getByRole("button", { name: "Project filter: All projects" });
  expect(filter.textContent).toBe("All projects");
  let row: HTMLElement | null = filter.parentElement;
  while (row && !within(row).queryByRole("link", { name: "New thread" })) row = row.parentElement;
  if (!row) throw new Error("No filter row");
  expect(titleRow.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // In the filter row beside the filter, after it, as a glyph alone.
  const start = within(row).getByRole("link", { name: "New thread" });
  expect(filter.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(start.textContent).toBe("");
  const threads = screen.getByRole("navigation", { name: "Threads" });
  expect(within(threads).queryByRole("link", { name: "New thread" })).toBeNull();
  await userEvent.hover(start);
  expect((await screen.findByRole("tooltip")).textContent).toContain("New thread");
});

test("every view's shortcut opens it from anywhere", async () => {
  // Not from New thread: with no project it is a chat, and its focused composer takes the keys.
  await harness().open("/settings");
  await title("Settings");
  for (const [keys, heading] of [
    ["gu", "Automations"],
    ["gs", "Skills"],
    ["go", "Usage"],
    ["{Meta>},{/Meta}", "Settings"],
    ["gp", "Pull requests"],
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
  // The page proper, past its skeleton (which draws a header of its own): with no project yet,
  // a chat's composer.
  await screen.findByRole("combobox", { name: "Message" });
  expect(list("Threads")).toBeNull();
  await userEvent.click(button("Show sidebar"));
  expect(await screen.findByRole("complementary", { name: "Threads" })).toBeTruthy();
});

/** The window's first three buttons are back, forward and the sidebar toggle named `toggle`. */
const leading = (toggle: string) =>
  expect(
    screen
      .getAllByRole("button")
      // The hidden sidebar's edge, a pointer-only way back (`tabIndex` -1).
      .filter((each) => each.dataset.sidebar !== "rail")
      .slice(0, 3),
  ).toEqual([
    screen.getByRole("button", { name: "Back" }),
    screen.getByRole("button", { name: "Forward" }),
    screen.getByRole("button", { name: toggle }),
  ]);

test("back, forward and the sidebar toggle lead the top bar whether the sidebar shows or not", async () => {
  const app = harness();
  app.play(longHistory(2)).runUntilBlocked();
  await app.open("/new");
  await title("New thread");
  const threads = await screen.findByRole("navigation", { name: "Threads" });
  await userEvent.click(within(threads).getByRole("link", { name: /Document the router/ }));
  await title("Document the router");

  // They come first in the window, before the rail and the panel, whichever half of the bar
  // holds them: the sidebar's top row while it shows, the header while it doesn't.
  leading("Hide sidebar");
  for (const name of ["Back", "Forward", "Hide sidebar"])
    expect(within(appNav()).queryByRole("button", { name })).toBeNull();

  await userEvent.click(screen.getByRole("button", { name: "Back" }));
  await title("New thread");
  await userEvent.click(screen.getByRole("button", { name: "Forward" }));
  await title("Document the router");

  // Sidebar hidden: the same three lead the header, the toggle now offering to show it.
  await userEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
  await waitFor(() => expect(list("Threads")).toBeNull());
  expect(screen.queryByRole("navigation", { name: "App" })).toBeNull();
  leading("Show sidebar");
  expect(header().getByRole("button", { name: "Back" })).toBeTruthy();

  await userEvent.click(header().getByRole("button", { name: "Back" }));
  await title("New thread");
  await userEvent.click(header().getByRole("button", { name: "Forward" }));
  await title("Document the router");

  await userEvent.click(header().getByRole("button", { name: "Show sidebar" }));
  expect(await screen.findByRole("complementary", { name: "Threads" })).toBeTruthy();
  leading("Hide sidebar");
});

test("with no project yet, the sidebar and the palette lead to Add project, and ⌘N starts a chat", async () => {
  await harness().open("/new");
  await title("New thread");
  const add = await within(
    await screen.findByRole("complementary", { name: "Threads" }),
  ).findByRole("button", { name: /^Add project/ });
  expect(within(appNav()).queryByRole("link", { name: /^New thread/ })).toBeNull();
  await userEvent.click(add);
  expect(await screen.findByRole("dialog", { name: "Add project" })).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add project" })).toBeNull());

  await userEvent.keyboard("{Meta>}k{/Meta}");
  const palette = await screen.findByRole("dialog", { name: "Command palette" });
  await userEvent.type(
    within(palette).getByRole("combobox", { name: "Search commands" }),
    "Add project",
  );
  const options = await within(palette).findAllByRole("option");
  expect(options[0]?.textContent).toMatch(/^Add project…/);
  expect(within(palette).queryByRole("option", { name: /^New thread/ })).toBeNull();
  const first = options[0];
  if (!first) throw new Error("Add project command is missing");
  await userEvent.click(first);
  expect(await screen.findByRole("dialog", { name: "Add project" })).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add project" })).toBeNull());

  // A chat needs no project (ADR 0099): ⌘N from elsewhere opens one rather than Add project.
  await userEvent.keyboard("{Meta>},{/Meta}");
  await title("Settings");
  await userEvent.keyboard("{Control>}n{/Control}");
  await title("New thread");
  const message = await screen.findByRole("combobox", { name: "Message" });
  expect(message.getAttribute("aria-placeholder")).toBe("Ask anything");
  expect(screen.queryByRole("dialog", { name: "Add project" })).toBeNull();
});

test("the profile leaves daemon trouble to the screen's one notice, naming it only to assistive tech", async () => {
  const app = harness();
  await app.open("/new");
  await title("New thread");
  const profile = button(/^You, account/);
  app.client.networkOnline(false);
  await waitFor(() => expect(profile.getAttribute("aria-label")).toContain("offline"));
  expect(profile.textContent).not.toMatch(/offline/i);
  expect(await screen.findAllByText(/^Offline/, { selector: "header *" })).toHaveLength(1);
  app.client.networkOnline(true);
  await waitFor(() => expect(profile.getAttribute("aria-label")).toBe("You, account"));
});

test("the panel's New thread row opens New thread in the one project there is", async () => {
  const app = harness();
  createIdleTask(app.daemon, {
    id: "tidy",
    title: "Tidy the README",
    workspaceId: "relay",
    provider: "codex",
  });
  await app.open("/t/tidy");
  await title("Tidy the README");
  const row = within(await screen.findByRole("complementary", { name: "Threads" })).getByRole(
    "link",
    { name: "New thread" },
  );
  await userEvent.click(row);
  await title("New thread");
  expect(row.getAttribute("aria-current")).toBe("page");
});

test("settled threads leave the Inbox, and the Settled tab lists every one of them", async () => {
  const app = harness();
  const titles = ["One", "Two", "Three", "Four", "Five", "Six", "Seven"].map(
    (word) => `${word} task`,
  );
  for (const [index, name] of titles.entries())
    createIdleTask(app.daemon, {
      id: `task-${index}`,
      title: name,
      workspaceId: "relay",
      provider: "codex",
    });
  await app.client.start();
  for (const index of titles.keys())
    await app.client.command({ type: "thread.settle", threadId: ThreadId.parse(`task-${index}`) });
  await app.open("/new");
  const nav = within(await screen.findByRole("navigation", { name: "Threads" }));
  await userEvent.click(await nav.findByRole("tab", { name: /^Settled/ }));
  // All seven at once: no project folds them behind Show more.
  await waitFor(() => expect(nav.getAllByRole("link", { name: / task\./ })).toHaveLength(7));
  expect(nav.queryByRole("button", { name: /^Show / })).toBeNull();
  await userEvent.click(nav.getByRole("tab", { name: "Inbox, 0" }));
  await waitFor(() => expect(nav.queryAllByRole("link", { name: / task\./ })).toHaveLength(0));
});

test("Skills, Automations, Settings and GitHub panels share one title row and one row", async () => {
  const app = workbenchApp();
  const panels = [
    { path: "/skills", name: "Skills", action: { role: "button", name: "Add a skill" } },
    {
      path: "/automations",
      name: "Automations",
      action: { role: "searchbox", name: "Search automations" },
    },
    {
      path: "/settings/general",
      name: "Settings",
      action: { role: "searchbox", name: "Search settings" },
    },
    { path: "/pulls", name: "Code review", action: undefined },
  ] as const;
  for (const panel of panels) {
    const view = await app.open(panel.path);
    const sidebar = within(await screen.findByRole("complementary", { name: panel.name }));
    // The title row: the place's name as the panel's heading, and its actions.
    expect(await sidebar.findByRole("heading", { level: 2, name: panel.name })).toBeTruthy();
    if (panel.action)
      expect(sidebar.getByRole(panel.action.role, { name: panel.action.name })).toBeTruthy();
    // Every row is the shared panel row.
    const links = await waitFor(() => {
      const found = sidebar.getAllByRole("link");
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    for (const link of links) expect(link.hasAttribute("data-panel-row")).toBe(true);
    view.unmount();
  }
});
