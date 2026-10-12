import { facts } from "@ace/fake-daemon";
import { ThreadId, WorkspaceId } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";
import { createIdleTask } from "@/test/tasks.ts";

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

test("all projects share one Home order and keyboard navigation crosses project boundaries", async () => {
  const app = harness();
  seed(app);
  await app.open("/new");
  const nav = within(await screen.findByRole("navigation", { name: "Threads" }));
  await nav.findByRole("link", { name: /^Last task/ });
  expect(nav.queryAllByRole("heading")).toHaveLength(0);
  const links = nav.getAllByRole("link");
  expect(links.map((link) => link.getAttribute("aria-label")?.split(".")[0])).toEqual([
    "Last task",
    "Other project",
    "First task",
  ]);
  const first = links[0];
  if (!first) throw new Error("Missing first row");
  first.focus();
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(links[1]);
  await userEvent.keyboard("j");
  expect(document.activeElement).toBe(links[2]);
  await userEvent.keyboard("k{ArrowUp}");
  expect(document.activeElement).toBe(first);
  expect(within(first).getByText("ace")).toBeTruthy();
  expect(within(first).getByText("Working", { exact: true })).toBeTruthy();
});

test("the project filter narrows the flat list while keeping project identity on each task", async () => {
  const storage = memoryKeyValue();
  storage.setItem(
    "ace.home.organizer",
    JSON.stringify({ project: "ace", baseline: 0, settledOpen: false }),
  );
  const app = harness({ storage });
  seed(app);
  await app.open("/new?project=ace");
  const nav = within(await screen.findByRole("navigation", { name: "Threads" }));
  const task = await nav.findByRole("link", { name: /^Last task/ });
  expect(within(task).getByText("ace")).toBeTruthy();
  expect(within(task).getByText("Working", { exact: true })).toBeTruthy();
  expect(nav.queryByRole("heading", { name: "ace" })).toBeNull();
  expect(nav.queryByRole("link", { name: /^Other project/ })).toBeNull();
});

test("failed and working tasks both keep visible status words", async () => {
  const app = harness();
  seed(app);
  app.daemon.apply("first", [facts.endTurn("root", "failed")]);
  await app.open("/new");
  const nav = within(await screen.findByRole("navigation", { name: "Threads" }));
  const failed = await nav.findByRole("link", { name: /^First task/ });
  expect(within(failed).getByText("Failed")).toBeTruthy();
  const working = nav.getByRole("link", { name: /^Last task/ });
  expect(within(working).getByText("Working", { exact: true })).toBeTruthy();
  expect(working.getAttribute("aria-label")).toContain("Working");
});

test("the project filter also narrows unsent starts without hiding matching work", async () => {
  const storage = memoryKeyValue();
  storage.setItem(
    "ace.home.organizer",
    JSON.stringify({ project: "ace", baseline: 0, settledOpen: false }),
  );
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

test("arrows and j/k cross the pinned boundary in both directions", async () => {
  const app = harness();
  seed(app);
  await app.open("/new");
  const nav = within(await screen.findByRole("navigation", { name: "Threads" }));
  await nav.findByRole("link", { name: /^Last task/ });
  await app.client.command({ type: "thread.pin", threadId: ThreadId.parse("first"), pinned: true });
  const pinned = await nav.findByRole("link", { name: /^First task.*Pinned/ });
  const next = nav.getByRole("link", { name: /^Last task/ });
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
  const nav = within(await screen.findByRole("navigation", { name: "Threads" }));
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
  const links = nav.getAllByRole("link");
  const lastTask = links[2];
  if (!lastTask) throw new Error("Missing admitted task");
  lastTask.focus();
  for (const next of links.slice(3)) {
    await userEvent.keyboard("j");
    await waitFor(() => expect(document.activeElement).toBe(next));
  }
  for (const previous of links.slice(2, -1).toReversed()) {
    await userEvent.keyboard("{ArrowUp}");
    await waitFor(() => expect(document.activeElement).toBe(previous));
  }
});

test("Snoozed folds quiet tasks away but leaves a request in the main list", async () => {
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
  await nav.findByRole("button", { name: "Snoozed (2)" });
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
  const snoozed = await nav.findByRole("button", { name: "Snoozed (1)" });
  await waitFor(() => expect(nav.queryByRole("link", { name: /^First task/ })).toBeNull());
  expect(nav.getByRole("link", { name: /^Last task/ })).toBeTruthy();
  await userEvent.click(snoozed);
  expect(await nav.findByRole("link", { name: /^First task/ })).toBeTruthy();
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
