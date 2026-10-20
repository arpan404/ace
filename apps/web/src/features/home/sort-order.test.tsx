import { workbench } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

const threads = () => screen.getByRole("navigation", { name: "Threads" });
const scenarios = workbench();
const titles = scenarios.map((scenario) => scenario.thread.title);
const card = (title: string) => within(threads()).getByRole("link", { name: new RegExp(title) });
/** Thread titles in the order the list shows them. */
const order = () =>
  within(threads())
    .queryAllByRole("link")
    .flatMap((link) => titles.find((title) => link.textContent?.includes(title)) ?? []);
const said = () => threads().querySelector("[aria-live]")?.textContent ?? "";

async function openHome(sortBy: "activity" | "created" | "manual") {
  const app = harness();
  app.daemon.services.settings.write("threads.sortBy", sortBy);
  for (const scenario of scenarios) app.play(scenario).runUntilBlocked();
  await app.open("/");
  await within(await screen.findByRole("navigation", { name: "Threads" })).findAllByRole("link");
  return app;
}

/** When each listed thread was created, by title. */
function createdAt(app: ReturnType<typeof harness>): Map<string, number> {
  const view = app.daemon.snapshot({ kind: "threads" });
  if (view?.kind !== "threads") return new Map();
  return new Map(Object.values(view.threads).map((thread) => [thread.title, thread.createdAt]));
}

test("sorted newest first, the list follows creation order rather than who needs you", async () => {
  const app = await openHome("created");
  const created = createdAt(app);
  const times = () => order().map((title) => created.get(title) ?? Number.NaN);
  expect(new Set(times()).size).toBeGreaterThan(1);
  await waitFor(() => expect(times()).toEqual(times().toSorted((a, b) => b - a)));
});

test("sorted by activity, a thread that needs you leads whenever it was created", async () => {
  const app = await openHome("activity");
  const created = createdAt(app);
  const times = order().map((title) => created.get(title) ?? Number.NaN);
  expect(times).not.toEqual(times.toSorted((a, b) => b - a));
});

test("sorted by hand, Space picks a thread up and arrows place it, for every device", async () => {
  const app = await openHome("manual");
  const before = order();
  const [first, second] = before;
  if (!first || !second) throw new Error("the workbench lists at least two threads");

  card(second).focus();
  await userEvent.keyboard(" ");
  await waitFor(() => expect(said()).toMatch(/place 2 of/));
  await userEvent.keyboard("{ArrowUp}");
  expect(said()).toMatch(/place 1 of/);
  await userEvent.keyboard(" ");

  await waitFor(() => expect(order().slice(0, 2)).toEqual([second, first]));
  // The daemon keeps the place, so every device shows the same order.
  await waitFor(() => {
    const view = app.daemon.snapshot({ kind: "threads" });
    const placed =
      view?.kind === "threads"
        ? Object.values(view.threads).find((thread) => thread.title === second)
        : undefined;
    expect(placed?.listOrder).toBeTypeOf("number");
  });
});
