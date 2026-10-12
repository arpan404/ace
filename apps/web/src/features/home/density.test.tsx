import { facts } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
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
      workspaceId: project,
      provider: "codex",
      title: `${project} pending task`,
      input: [{ type: "text", text: `${project} pending task` }],
    });
  expect(await nav.findByRole("link", { name: /^ace pending task/ })).toBeTruthy();
  expect(nav.queryByRole("link", { name: /^relay pending task/ })).toBeNull();
});
