import { facts } from "@ace/fake-daemon";
import { ThreadId, WorkspaceId } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";
import { createIdleTask } from "@/test/tasks.ts";
import { rowText } from "@/test/row-text.ts";

/** The colour (tone) of a row's status icon, found by the status's meaning. */
const toneOf = (row: HTMLElement, meaning: string) =>
  within(row).getByRole("img", { name: meaning }).querySelector<HTMLElement>("[data-icon]")?.dataset
    .tone;

/** One of the panel's tabs (Inbox, Snoozed or Settled), found by its name and count. */
const tab = (nav: ReturnType<typeof within>, name: string) => nav.findByRole("tab", { name });

function seed(app: ReturnType<typeof harness>) {
  for (const [id, title, project] of [
    ["first", "First task", "ace"],
    ["middle", "Other project", "relay"],
    ["last", "Last task", "ace"],
  ]) {
    if (!id || !title || !project) throw new Error("Incomplete task");
    createIdleTask(app.daemon, { id, title, workspaceId: project, provider: "codex" });
    app.daemon.apply(id, [facts.turn("root")]);
  }
}

test("the Inbox spans projects, and the arrows walk its rows both ways", async () => {
  const app = harness();
  seed(app);
  await app.open("/new");
  const nav = within(await screen.findByRole("navigation", { name: "Threads" }));
  await nav.findByRole("link", { name: /^Last task/ });
  const links = nav.getAllByRole("link");
  expect(links.map((link) => link.getAttribute("aria-label")?.split(".")[0])).toEqual([
    "Last task",
    "Other project",
    "First task",
  ]);
  const [first, second, third] = links;
  if (!first || !second || !third) throw new Error("Missing rows");
  // A row leads with its project's name (no mark) and its status, then its title.
  expect(rowText(first)).toMatch(/^ace.*Last task/);
  expect(first.querySelector('[data-icon="working"]')).toBeTruthy();
  expect(first.querySelector("[data-live], .fx-live-dot, [data-state]")).toBeNull();
  expect(first.querySelector("[data-project-mark]")).toBeNull();
  first.focus();
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(second);
  await userEvent.keyboard("j");
  expect(document.activeElement).toBe(third);
  // The last row is the end: no project headings below it.
  await userEvent.keyboard("j");
  expect(document.activeElement).toBe(third);
  await userEvent.keyboard("k{ArrowUp}");
  expect(document.activeElement).toBe(first);
  // Keyboard focus brings up the row's actions beside its status, which stays.
  expect(first.querySelector('[data-icon="working"]')).toBeTruthy();
  expect(screen.getByRole("button", { name: "Snooze Last task" })).toBeTruthy();
});

test("the project filter narrows the Inbox to one project", async () => {
  const storage = memoryKeyValue();
  storage.setItem("ace.home.organizer", JSON.stringify({ project: "ace", baseline: 0 }));
  const app = harness({ storage });
  seed(app);
  await app.open("/new?project=ace");
  const nav = within(await screen.findByRole("navigation", { name: "Threads" }));
  const task = await nav.findByRole("link", { name: /^Last task/ });
  expect(task.querySelector('[data-icon="working"]')).toBeTruthy();
  expect(screen.getByRole("button", { name: "Project filter: ace" })).toBeTruthy();
  expect(nav.queryByRole("link", { name: /^Other project/ })).toBeNull();
  expect(await tab(nav, "Inbox, 2")).toBeTruthy();
});

test("failed and working tasks say so in their names and icons, with no status word", async () => {
  const app = harness();
  seed(app);
  app.daemon.apply("first", [facts.endTurn("root", "failed")]);
  await app.open("/new");
  const nav = within(await screen.findByRole("navigation", { name: "Threads" }));
  const failed = await nav.findByRole("link", { name: /^First task/ });
  expect(failed.getAttribute("aria-label")).toContain("Failed");
  // Its failure predates this device, so it reads as seen: the grey icon beside its age.
  expect(
    within(failed).getByRole("img", { name: "Failed" }).querySelector('[data-icon="failed"]'),
  ).toBeTruthy();
  expect(within(failed).queryByText("Failed", { exact: true })).toBeNull();
  expect(failed.querySelector("[data-live], .fx-live-dot, [data-state]")).toBeNull();
  const working = nav.getByRole("link", { name: /^Last task/ });
  expect(working.querySelector('[data-icon="working"]')).toBeTruthy();
  expect(working.getAttribute("aria-label")).toContain("Working");
});

test("the project filter also narrows unsent starts without hiding matching work", async () => {
  const storage = memoryKeyValue();
  storage.setItem("ace.home.organizer", JSON.stringify({ project: "ace", baseline: 0 }));
  const app = harness({ storage });
  seed(app);
  await app.open("/new?project=ace");
  const nav = within(await screen.findByRole("navigation", { name: "Threads" }));
  await nav.findByRole("link", { name: /^Last task/ });
  app.client.networkOnline(false);
  for (const project of ["ace", "relay"])
    await app.client.enqueue({
      type: "thread.create",
      workspaceId: WorkspaceId.parse(project),
      provider: "codex",
      title: `${project} pending task`,
      input: [{ type: "text", text: `${project} pending task` }],
    });
  expect(await nav.findByRole("link", { name: /^ace pending task/ })).toBeTruthy();
  expect(nav.queryByRole("link", { name: /^relay pending task/ })).toBeNull();
});

test("a pinned thread leads the Inbox as a full task row, and arrows move on from it", async () => {
  const app = harness();
  seed(app);
  await app.open("/new");
  const nav = within(await screen.findByRole("navigation", { name: "Threads" }));
  await nav.findByRole("link", { name: /^Last task/ });
  await app.client.command({ type: "thread.pin", threadId: ThreadId.parse("first"), pinned: true });
  const pinned = await nav.findByRole("link", { name: /^First task.*Pinned/ });
  await waitFor(() =>
    expect(
      nav.getAllByRole("link").map((link) => link.getAttribute("aria-label")?.split(".")[0]),
    ).toEqual(["First task", "Last task", "Other project"]),
  );
  // No heading over the pins: the Inbox is one list, and a pinned row is a task row like any.
  expect(nav.queryByRole("heading", { name: "Active" })).toBeNull();
  expect(rowText(pinned)).toMatch(/^ace.*First task/);
  // The next stop down: the Inbox's next row.
  const navigation = screen.getByRole("navigation", { name: "Threads" });
  const stops = [
    ...navigation.querySelectorAll<HTMLElement>("[data-row-focus], [data-section-toggle]"),
  ];
  const next = stops[stops.indexOf(pinned) + 1];
  pinned.focus();
  await userEvent.keyboard("{ArrowDown}");
  await waitFor(() => expect(document.activeElement).toBe(next));
  await userEvent.keyboard("{ArrowUp}");
  await waitFor(() => expect(document.activeElement).toBe(pinned));
  await userEvent.keyboard("j");
  await waitFor(() => expect(document.activeElement).toBe(next));
  await userEvent.keyboard("k");
  await waitFor(() => expect(document.activeElement).toBe(pinned));
});

test("navigation includes every Unsent link in both directions", async () => {
  const app = harness();
  seed(app);
  await app.open("/new");
  const navigation = await screen.findByRole("navigation", { name: "Threads" });
  const nav = within(navigation);
  await nav.findByRole("link", { name: /^First task/ });
  app.client.networkOnline(false);
  for (const title of ["First offline task", "Second offline task"])
    await app.client.enqueue({
      type: "thread.create",
      workspaceId: WorkspaceId.parse("ace"),
      provider: "codex",
      title,
      input: [{ type: "text", text: title }],
    });
  await nav.findByRole("link", { name: /^Second offline task/ });
  // Every stop the arrows reach, top to bottom: Unsent links, headings, places and rows.
  const stops = [
    ...navigation.querySelectorAll<HTMLElement>("[data-row-focus], [data-section-toggle]"),
  ];
  const [top] = stops;
  if (!top) throw new Error("Missing the first stop");
  expect(top.textContent).toContain("First offline task");
  top.focus();
  for (const next of stops.slice(1)) {
    await userEvent.keyboard("j");
    await waitFor(() => expect(document.activeElement).toBe(next));
  }
  for (const previous of stops.slice(0, -1).toReversed()) {
    await userEvent.keyboard("{ArrowUp}");
    await waitFor(() => expect(document.activeElement).toBe(previous));
  }
});

test("snoozed tasks leave the Inbox for Snoozed, and a snoozed task that asks for you comes back to the Inbox", async () => {
  const now = 100_000;
  const app = harness({ clock: () => now, uiClock: () => now });
  seed(app);
  await app.open("/new");
  const nav = within(await screen.findByRole("navigation", { name: "Threads" }));
  await nav.findByRole("link", { name: /^Last task/ });
  for (const id of ["first", "last"])
    await app.client.command({
      type: "thread.snooze",
      threadId: ThreadId.parse(id),
      until: now + 3_600_000,
    });
  await tab(nav, "Snoozed, 2");
  await waitFor(() => expect(nav.queryByRole("link", { name: /^First task/ })).toBeNull());
  app.daemon.apply("last", [
    {
      type: "interaction.opened",
      agent: "root",
      interaction: "ask",
      blocking: true,
      request: {
        kind: "approval",
        title: "Proceed?",
        options: [{ id: "allow", label: "Approve", kind: "allow_once" }],
      },
    },
  ]);
  const snoozed = await tab(nav, "Snoozed, 1");
  expect(nav.queryByRole("link", { name: /^First task/ })).toBeNull();
  // The request leaves Snoozed for the Inbox, its icon in the needs-you colour.
  const last = await nav.findByRole("link", { name: /^Last task/ });
  await waitFor(() => expect(toneOf(last, "Needs approval")).toBe("needs-you"));
  await userEvent.click(snoozed);
  expect(await nav.findByRole("link", { name: /^First task/ })).toBeTruthy();
  expect(nav.queryByRole("link", { name: /^Last task/ })).toBeNull();
});

test("Snoozed lists what wakes soonest first, and each row's name says when it wakes", async () => {
  const now = 100_000;
  const app = harness({ clock: () => now, uiClock: () => now });
  for (const [id, title] of [
    ["later", "Wakes later"],
    ["sooner", "Wakes sooner"],
  ] as const)
    createIdleTask(app.daemon, { id, title, workspaceId: "ace", provider: "codex" });
  await app.open("/new");
  const nav = within(await screen.findByRole("navigation", { name: "Threads" }));
  await nav.findByRole("link", { name: /^Wakes later/ });
  for (const [id, hours] of [
    ["later", 3],
    ["sooner", 1],
  ] as const)
    await app.client.command({
      type: "thread.snooze",
      threadId: ThreadId.parse(id),
      until: now + hours * 3_600_000,
    });
  await userEvent.click(await tab(nav, "Snoozed, 2"));
  await nav.findByRole("link", { name: /^Wakes sooner/ });
  const rows = nav.getAllByRole("link", { name: /^Wakes / });
  expect(rows.map((row) => row.getAttribute("aria-label")?.split(".")[0])).toEqual([
    "Wakes sooner",
    "Wakes later",
  ]);
  for (const row of rows)
    expect(row.getAttribute("aria-label")).toMatch(/Snoozed until .*\d{1,2}:\d{2}/);
});

test("an Unsent-only list supports forward and backward navigation", async () => {
  const storage = memoryKeyValue();
  const app = harness({ storage });
  storage.setItem(
    `ace.preparations:${app.daemon.hostId}`,
    JSON.stringify([
      [
        "saved-release-plan",
        { project: "relay", title: "Draft release plan", provider: "codex", choices: {} },
      ],
    ]),
  );
  await app.open("/new");
  const nav = within(await screen.findByRole("navigation", { name: "Threads" }));
  app.client.networkOnline(false);
  for (const title of ["First offline task", "Second offline task"])
    await app.client.enqueue({
      type: "thread.create",
      workspaceId: WorkspaceId.parse("ace"),
      provider: "codex",
      title,
      input: [{ type: "text", text: title }],
    });
  await nav.findByRole("link", { name: /^Second offline task/ });
  await nav.findByRole("link", { name: /^Draft release plan/ });
  const links = nav.getAllByRole("link");
  const first = links[0];
  if (!first) throw new Error("Missing first Unsent task");
  first.focus();
  for (const next of links.slice(1)) {
    await userEvent.keyboard("j");
    await waitFor(() => expect(document.activeElement).toBe(next));
  }
  for (const previous of links.slice(0, -1).toReversed()) {
    await userEvent.keyboard("{ArrowUp}");
    await waitFor(() => expect(document.activeElement).toBe(previous));
  }
});

test.each([
  ["not_sent", "Not sent", "needs-you"],
  ["uncertain", "Review a message", "waiting"],
] as const)(
  "renewed %s queue recovery shows in the Inbox saying %s while the Snoozed tab stays closed",
  async (reason, label, tone) => {
    const now = 100_000;
    const app = harness({ clock: () => now, uiClock: () => now });
    for (const [id, title] of [
      ["recovery", "Recover the saved message"],
      ["quiet", "Review this later"],
    ] as const)
      createIdleTask(app.daemon, { id, title, workspaceId: "ace", provider: "codex" });
    await app.open("/new");
    const nav = within(await screen.findByRole("navigation", { name: "Threads" }));
    await nav.findByRole("link", { name: /^Recover the saved message/ });
    for (const id of ["recovery", "quiet"])
      await app.client.command({
        type: "thread.snooze",
        threadId: ThreadId.parse(id),
        until: now + 3_600_000,
      });
    const closed = await tab(nav, "Snoozed, 2");
    expect(closed.getAttribute("aria-selected")).toBe("false");
    await waitFor(() =>
      expect(nav.queryByRole("link", { name: /^Recover the saved message/ })).toBeNull(),
    );
    app.daemon.holdQueue("recovery", reason);
    const name = new RegExp(`^Recover the saved message.*${label}`);
    // The row's icon says it, named for it: Not sent in the needs-you colour, a review in the waiting colour.
    const row = await nav.findByRole("link", { name });
    expect(toneOf(row, label)).toBe(tone);
    const remaining = await tab(nav, "Snoozed, 1");
    expect(remaining.getAttribute("aria-selected")).toBe("false");
    expect(nav.queryByRole("link", { name: /^Review this later/ })).toBeNull();
  },
);
