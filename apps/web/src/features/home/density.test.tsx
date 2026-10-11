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

test("all-project rows group under project headings and keyboard arrows follow the drawn order", async () => {
  const app = harness();
  seed(app);
  await app.open("/new");
  const nav = within(await screen.findByRole("navigation", { name: "Threads" }));
  expect(await nav.findByRole("heading", { name: "ace" })).toBeTruthy();
  expect(nav.getByRole("heading", { name: "relay" })).toBeTruthy();
  const links = nav.getAllByRole("link");
  expect(links.map((link) => link.getAttribute("aria-label")?.split(".")[0])).toEqual([
    "Last task",
    "First task",
    "Other project",
  ]);
  const first = links[0];
  if (!first) throw new Error("Missing first row");
  first.focus();
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(links[1]);
  expect(first.textContent).not.toContain("ace");
});

test("a selected project keeps compact rows without repeating its project heading", async () => {
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
  expect(nav.queryByRole("heading", { name: "ace" })).toBeNull();
  expect(nav.queryByRole("link", { name: /^Other project/ })).toBeNull();
});

test("a failed thread keeps its attention label while routine work has no status word", async () => {
  const app = harness();
  seed(app);
  app.daemon.apply("first", [facts.endTurn("root", "failed")]);
  await app.open("/new");
  const nav = within(await screen.findByRole("navigation", { name: "Threads" }));
  const failed = await nav.findByRole("link", { name: /^First task/ });
  expect(within(failed).getByText("Failed")).toBeTruthy();
  const working = nav.getByRole("link", { name: /^Last task/ });
  expect(within(working).queryByText("Working")).toBeNull();
  expect(working.getAttribute("aria-label")).toContain("Working");
});
