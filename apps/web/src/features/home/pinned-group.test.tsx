import { workbench } from "@ace/fake-daemon";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
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
  const [heading] = within(threads()).queryAllByText(
    (_, element) => element !== null && /^Pinned \d+$/.test(element.textContent ?? ""),
  );
  if (!heading) return [];
  const count = Number(/(\d+)$/.exec(heading.textContent ?? "")?.[1]);
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

/** A pinned row's touch drag handle, as a phone shows it. */
const handle = (title: string) => within(threads()).getByRole("button", { name: `Move ${title}` });

test("a pinned row's handle starts a keyboard move with Enter, as Space does on the row", async () => {
  await openHome();
  await pinFromRow(/^Invoice PDF/, "Pin Invoice PDF locale fallback");
  await pinFromRow(/^Backpressure/, "Pin Backpressure on broadcast fan-out");
  await waitFor(() => expect(pinnedGroup()).toHaveLength(2));
  // Only pinned rows carry one.
  expect(within(threads()).queryByRole("button", { name: /^Move Retry budget/ })).toBeNull();

  handle("Backpressure on broadcast fan-out").focus();
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(said()).toMatch(/^Moving Backpressure.*Pinned, place 1 of 2/));
  await userEvent.keyboard("{ArrowDown} ");
  await waitFor(() =>
    expect(pinnedGroup()).toEqual([
      "Invoice PDF locale fallback",
      "Backpressure on broadcast fan-out",
    ]),
  );
});

test("a finger on a row scrolls the list; a finger on its handle drags it", async () => {
  await openHome();
  await pinFromRow(/^Invoice PDF/, "Pin Invoice PDF locale fallback");
  await pinFromRow(/^Backpressure/, "Pin Backpressure on broadcast fan-out");
  await waitFor(() => expect(pinnedGroup()).toHaveLength(2));
  const touch = { pointerId: 7, pointerType: "touch", button: 0, buttons: 1 };

  // Invoice PDF is second in the group; its handle carries it to the top.
  fireEvent.pointerDown(handle("Invoice PDF locale fallback"), {
    ...touch,
    clientX: 200,
    clientY: 120,
  });
  await waitFor(() => {
    fireEvent.pointerMove(window, { ...touch, clientX: 200, clientY: 1 });
    expect(said()).toMatch(/^Moving Invoice PDF/);
  });
  fireEvent.pointerUp(window, { ...touch, clientX: 200, clientY: 1 });
  await waitFor(() =>
    expect(pinnedGroup()).toEqual([
      "Invoice PDF locale fallback",
      "Backpressure on broadcast fan-out",
    ]),
  );
  expect(said()).toBe("Dropped Invoice PDF locale fallback: Pinned, place 1 of 2");

  // The same gesture on the row itself, with the drag code loaded, is a scroll: nothing moves.
  fireEvent.pointerDown(card(/^Backpressure/), { ...touch, clientX: 20, clientY: 120 });
  await act(() => new Promise((settle) => setTimeout(settle, 20)));
  fireEvent.pointerMove(window, { ...touch, clientX: 20, clientY: 1 });
  await act(() => new Promise((settle) => requestAnimationFrame(settle)));
  fireEvent.pointerUp(window, { ...touch, clientX: 20, clientY: 1 });
  expect(said()).toBe("Dropped Invoice PDF locale fallback: Pinned, place 1 of 2");
  expect(pinnedGroup()).toEqual([
    "Invoice PDF locale fallback",
    "Backpressure on broadcast fan-out",
  ]);
});
