import { facts } from "@ace/fake-daemon";
import { ThreadId, WorkspaceId } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";
import { createIdleTask } from "@/test/tasks.ts";

/** The one mark at a row's right edge (`RowIndicator`), by kind. */
const mark = (row: HTMLElement) =>
  row.querySelector<HTMLElement>("[data-indicator]")?.dataset.indicator;

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

test("projects group their threads, and keyboard navigation crosses project boundaries", async () => {
  const app = harness();
  seed(app);
  await app.open("/new");
  const nav = within(await screen.findByRole("navigation", { name: "Threads" }));
  await nav.findByRole("link", { name: /^Last task/ });
  const links = nav.getAllByRole("link");
  expect(links.map((link) => link.getAttribute("aria-label")?.split(".")[0])).toEqual([
    "Last task",
    "First task",
    "Other project",
  ]);
  const [first, second, other] = links;
  if (!first || !second || !other) throw new Error("Missing rows");
  // Inside its project a row doesn't repeat the project; it is its title and its live mark.
  expect(first.textContent).toBe("Last task");
  expect(mark(first)).toBe("live");
  const relay = nav.getByRole("button", { name: /^relay/ });
  first.focus();
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(second);
  await userEvent.keyboard("j");
  expect(document.activeElement).toBe(relay);
  await userEvent.keyboard("j");
  expect(document.activeElement).toBe(other);
  await userEvent.keyboard("kk{ArrowUp}");
  expect(document.activeElement).toBe(first);
  // Keyboard focus puts the row's actions where its mark was.
  expect(mark(first)).toBeUndefined();
  expect(screen.getByRole("button", { name: "Snooze Last task" })).toBeTruthy();
});

test("the project filter narrows the tree to one project", async () => {
  const storage = memoryKeyValue();
  storage.setItem("ace.home.organizer", JSON.stringify({ project: "ace", baseline: 0 }));
  const app = harness({ storage });
  seed(app);
  await app.open("/new?project=ace");
  const nav = within(await screen.findByRole("navigation", { name: "Threads" }));
  const task = await nav.findByRole("link", { name: /^Last task/ });
  expect(mark(task)).toBe("live");
  expect(nav.getByRole("button", { name: /^ace/ })).toBeTruthy();
  expect(nav.queryByRole("button", { name: /^relay/ })).toBeNull();
  expect(nav.queryByRole("link", { name: /^Other project/ })).toBeNull();
});

test("failed and working tasks say so in their names, and only live work keeps a mark once a failure is seen", async () => {
  const app = harness();
  seed(app);
  app.daemon.apply("first", [facts.endTurn("root", "failed")]);
  await app.open("/new");
  const nav = within(await screen.findByRole("navigation", { name: "Threads" }));
  const failed = await nav.findByRole("link", { name: /^First task/ });
  expect(failed.getAttribute("aria-label")).toContain("Failed");
  expect(within(failed).queryByText("Failed")).toBeNull();
  expect(mark(failed)).toBeUndefined();
  const working = nav.getByRole("link", { name: /^Last task/ });
  expect(within(working).queryByText("Working")).toBeNull();
  expect(working.getAttribute("aria-label")).toContain("Working");
  expect(mark(working)).toBe("live");
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

test("a pinned thread leads the panel under Pinned, and arrows move on from it", async () => {
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
  expect(nav.getByRole("heading", { name: "Pinned" })).toBeTruthy();
  expect(pinned.textContent).toBe("First task");
  // The next stop down: the Projects label's Add project, then the projects and their rows.
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

test("Snoozed folds quiet tasks away, and a snoozed task that asks for you waits in the Inbox", async () => {
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
  await nav.findByRole("button", { name: "Snoozed 2" });
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
  const snoozed = await nav.findByRole("button", { name: "Snoozed 1" });
  await waitFor(() => expect(nav.queryByRole("link", { name: /^First task/ })).toBeNull());
  // The request leaves Snoozed and its project for the Inbox.
  expect(nav.queryByRole("link", { name: /^Last task/ })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Inbox, 1 waiting" }));
  const inbox = await screen.findByRole("dialog", { name: "Inbox" });
  expect(within(inbox).getByRole("link", { name: /^Last task/ })).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Inbox" })).toBeNull());
  await userEvent.click(snoozed);
  expect(await nav.findByRole("link", { name: /^First task/ })).toBeTruthy();
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
  await userEvent.click(await nav.findByRole("button", { name: "Snoozed 2" }));
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
  ["not_sent", "Not sent", "the Inbox"],
  ["uncertain", "Review a message", "its project"],
] as const)(
  "renewed %s queue recovery shows in %s while Snoozed stays closed",
  async (reason, label, place) => {
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
    const closed = await nav.findByRole("button", { name: "Snoozed 2" });
    expect(closed.getAttribute("aria-expanded")).toBe("false");
    await waitFor(() =>
      expect(nav.queryByRole("link", { name: /^Recover the saved message/ })).toBeNull(),
    );
    app.daemon.holdQueue("recovery", reason);
    const name = new RegExp(`^Recover the saved message.*${label}`);
    let row: HTMLElement;
    if (place === "the Inbox") {
      // A message that wasn't sent needs the person: it waits in the Inbox, not its project.
      await userEvent.click(await screen.findByRole("button", { name: "Inbox, 1 waiting" }));
      row = await within(await screen.findByRole("dialog", { name: "Inbox" })).findByRole("link", {
        name,
      });
      expect(nav.queryByRole("link", { name })).toBeNull();
    } else row = await nav.findByRole("link", { name });
    // In the Inbox the row says it in words; in its project a wait is the live mark alone.
    if (place === "the Inbox") expect(within(row).getByText(label, { exact: true })).toBeTruthy();
    else expect(row.querySelector("[data-indicator]")?.getAttribute("data-indicator")).toBe("live");
    const remaining = await nav.findByRole("button", { name: "Snoozed 1" });
    expect(remaining.getAttribute("aria-expanded")).toBe("false");
    expect(nav.queryByRole("link", { name: /^Review this later/ })).toBeNull();
  },
);
