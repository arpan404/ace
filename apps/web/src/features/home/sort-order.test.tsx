import { facts } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { createIdleTask } from "@/test/tasks.ts";

beforeEach(() => localStorage.clear());

const threads = () => screen.getByRole("navigation", { name: "Threads" });
const titles = ["Oldest task", "Middle task", "Newest task"];
const card = (title: string) => within(threads()).getByRole("link", { name: new RegExp(title) });
/** Thread titles in the order the project lists them. */
const order = () =>
  within(threads())
    .queryAllByRole("link")
    .flatMap((link) => titles.find((title) => link.textContent?.includes(title)) ?? []);
const said = () => threads().querySelector("[aria-live]")?.textContent ?? "";

/** Three threads in one project, created oldest first; the oldest is working again. */
async function openHome(sortBy: "activity" | "created" | "manual") {
  const app = harness();
  app.daemon.services.settings.write("threads.sortBy", sortBy);
  for (const [index, title] of titles.entries())
    createIdleTask(app.daemon, {
      id: `task-${index}`,
      title,
      workspaceId: "ace",
      provider: "codex",
    });
  app.daemon.apply("task-0", [facts.turn("root")]);
  await app.open("/");
  await within(await screen.findByRole("navigation", { name: "Threads" })).findAllByRole("link");
  return app;
}

test("sorted newest first, a project lists its threads by creation, whatever is running", async () => {
  await openHome("created");
  await waitFor(() => expect(order()).toEqual(["Newest task", "Middle task", "Oldest task"]));
});

test("sorted by activity, a running thread leads its project whenever it was created", async () => {
  await openHome("activity");
  await waitFor(() => expect(order()).toEqual(["Oldest task", "Newest task", "Middle task"]));
});

test("sorted by hand, Space picks a thread up and arrows place it in its project, for every device", async () => {
  const app = await openHome("manual");
  await waitFor(() => expect(order()).toEqual(["Newest task", "Middle task", "Oldest task"]));

  card("Middle task").focus();
  await userEvent.keyboard(" ");
  await waitFor(() => expect(said()).toMatch(/place 2 of 3/));
  await userEvent.keyboard("{ArrowUp}");
  expect(said()).toMatch(/place 1 of 3/);
  await userEvent.keyboard(" ");

  await waitFor(() => expect(order()).toEqual(["Middle task", "Newest task", "Oldest task"]));
  // The daemon keeps the place, so every device shows the same order.
  await waitFor(() => {
    const view = app.daemon.snapshot({ kind: "threads" });
    const placed = view?.kind === "threads" ? view.threads["task-1"] : undefined;
    expect(placed?.listOrder).toBeTypeOf("number");
  });
});
