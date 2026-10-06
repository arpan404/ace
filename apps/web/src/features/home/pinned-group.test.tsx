import { workbench } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

const threads = () => screen.getByRole("navigation", { name: "Threads" });
const titles = workbench().map((scenario) => scenario.thread.title);
const card = (title: RegExp) => within(threads()).getByRole("link", { name: title });
/** Thread titles in the order the list shows them. */
const order = () =>
  within(threads())
    .queryAllByRole("link")
    .map((link) => titles.find((title) => link.textContent?.includes(title)));
/** The Pinned group, top to bottom: the rows between its heading and the first unpinned row. */
const pinnedGroup = () => {
  const heading = within(threads()).queryByText(/^Pinned \(\d+\)$/);
  if (!heading) return [];
  const count = Number(/\((\d+)\)/.exec(heading.textContent ?? "")?.[1]);
  return order().slice(0, count);
};
/** What the live region last said. */
const said = () => threads().querySelector("[aria-live]")?.textContent ?? "";

async function openHome() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/");
  await within(await screen.findByRole("navigation", { name: "Threads" })).findAllByRole("link");
  return app;
}
type App = Awaited<ReturnType<typeof openHome>>;
function listed(app: App, id: string) {
  const view = app.daemon.snapshot({ kind: "threads" });
  return view?.kind === "threads" ? view.threads[id] : undefined;
}

/** Pin from the row's own hover button, as a person pointing at it would. */
async function pinFromRow(title: RegExp, name: string) {
  await userEvent.hover(card(title));
  await userEvent.click(within(threads()).getByRole("button", { name }));
}

test("pinned threads gather under a Pinned heading, each new pin leading the group", async () => {
  await openHome();
  expect(within(threads()).queryByText(/^Pinned/)).toBeNull();
  await pinFromRow(/^Invoice PDF/, "Pin Invoice PDF locale fallback");
  await pinFromRow(/^Backpressure/, "Pin Backpressure on broadcast fan-out");
  await waitFor(() =>
    expect(pinnedGroup()).toEqual([
      "Backpressure on broadcast fan-out",
      "Invoice PDF locale fallback",
    ]),
  );
  // Ahead of the threads that need you: the person put them there.
  expect(order()[2]).toBe("Partial refunds double-count tax");
});

test("P on a focused row pins it, P again unpins it, and Undo puts it back in its place", async () => {
  const app = await openHome();
  await pinFromRow(/^Invoice PDF/, "Pin Invoice PDF locale fallback");
  card(/^Backpressure/).focus();
  await userEvent.keyboard("p");
  await waitFor(() => expect(pinnedGroup()[0]).toBe("Backpressure on broadcast fan-out"));
  await waitFor(() => expect(listed(app, "thread-fan-out")?.pinned).toBe(true));
  const place = listed(app, "thread-fan-out")?.pinOrder;

  card(/^Backpressure/).focus();
  await userEvent.keyboard("p");
  await waitFor(() => expect(pinnedGroup()).toEqual(["Invoice PDF locale fallback"]));
  await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
  await waitFor(() =>
    expect(pinnedGroup()).toEqual([
      "Backpressure on broadcast fan-out",
      "Invoice PDF locale fallback",
    ]),
  );
  await waitFor(() => expect(listed(app, "thread-fan-out")?.pinOrder).toBe(place));
});

test("Space picks a pinned row up, arrows choose its place, Space drops it there for every device", async () => {
  const app = await openHome();
  await pinFromRow(/^Invoice PDF/, "Pin Invoice PDF locale fallback");
  await pinFromRow(/^Rewrite the install/, "Pin Rewrite the install page for the daemon");
  await pinFromRow(/^Backpressure/, "Pin Backpressure on broadcast fan-out");
  await waitFor(() => expect(pinnedGroup()).toHaveLength(3));

  card(/^Backpressure/).focus();
  await userEvent.keyboard(" ");
  await waitFor(() => expect(said()).toMatch(/^Moving Backpressure.*Pinned, place 1 of 3/));
  await userEvent.keyboard("{ArrowDown}");
  expect(said()).toMatch(/Pinned, place 2 of 3/);
  await userEvent.keyboard("{ArrowDown}");
  expect(said()).toMatch(/Pinned, place 3 of 3/);
  await userEvent.keyboard(" ");

  const moved = [
    "Rewrite the install page for the daemon",
    "Invoice PDF locale fallback",
    "Backpressure on broadcast fan-out",
  ];
  await waitFor(() => expect(pinnedGroup()).toEqual(moved));
  expect(said()).toMatch(/^Dropped Backpressure/);
  // The daemon keeps the order: its places sort the same way.
  await waitFor(() => {
    const places = ["thread-install-page", "thread-pdf-locale", "thread-fan-out"].map(
      (id) => listed(app, id)?.pinOrder ?? Number.NaN,
    );
    expect(places).toEqual(places.toSorted((a, b) => b - a));
  });
});

test("Escape puts a keyboard move down where it started", async () => {
  await openHome();
  await pinFromRow(/^Invoice PDF/, "Pin Invoice PDF locale fallback");
  await pinFromRow(/^Backpressure/, "Pin Backpressure on broadcast fan-out");
  await waitFor(() => expect(pinnedGroup()).toHaveLength(2));
  const before = pinnedGroup();
  card(/^Backpressure/).focus();
  await userEvent.keyboard(" ");
  await waitFor(() => expect(said()).toMatch(/^Moving/));
  await userEvent.keyboard("{ArrowDown}{Escape}");
  expect(said()).toBe("Move cancelled");
  expect(pinnedGroup()).toEqual(before);
});

test("moving a pinned thread below the group unpins it, and moving another in pins it", async () => {
  const app = await openHome();
  await pinFromRow(/^Invoice PDF/, "Pin Invoice PDF locale fallback");
  await waitFor(() => expect(pinnedGroup()).toHaveLength(1));

  card(/^Invoice PDF/).focus();
  await userEvent.keyboard(" ");
  await waitFor(() => expect(said()).toMatch(/^Moving/));
  await userEvent.keyboard("{ArrowDown}");
  expect(said()).toMatch(/: unpin$/);
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(within(threads()).queryByText(/^Pinned/)).toBeNull());
  await waitFor(() => expect(listed(app, "thread-pdf-locale")?.pinned).toBe(false));

  // An unpinned thread starts outside the group; Up takes it in.
  card(/^Retry budget/).focus();
  await userEvent.keyboard(" ");
  await waitFor(() => expect(said()).toMatch(/not pinned/));
  await userEvent.keyboard("{ArrowUp} ");
  await waitFor(() => expect(pinnedGroup()).toEqual(["Retry budget for app-server restarts"]));
});
