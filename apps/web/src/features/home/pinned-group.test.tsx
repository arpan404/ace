import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { createIdleTask } from "@/test/tasks.ts";

beforeEach(() => localStorage.clear());

const threads = () => screen.getByRole("navigation", { name: "Threads" });
/** Three resting threads in ace, newest first by activity, and one in relay. */
const seeded = [
  ["alpha", "Alpha task", "ace"],
  ["beta", "Beta task", "ace"],
  ["gamma", "Gamma task", "ace"],
  ["other", "Other project task", "relay"],
] as const;
const titles = seeded.map(([, title]) => title);
const card = (title: RegExp) => within(threads()).getByRole("link", { name: title });
/** Thread titles in the order the list shows them. */
const order = () =>
  within(threads())
    .queryAllByRole("link")
    .map((link) => titles.find((title) => link.textContent?.includes(title)));
/** ace's pinned threads, top to bottom: they lead its list. */
const pinnedGroup = () =>
  within(threads())
    .queryAllByRole("link", { name: /\bPinned\b/ })
    .map((link) => titles.find((title) => link.textContent?.includes(title)))
    .filter((title) => title !== "Other project task");
/** What the live region last said. */
const said = () => threads().querySelector("[aria-live]")?.textContent ?? "";

async function openHome() {
  const app = harness();
  for (const [id, title, project] of seeded)
    createIdleTask(app.daemon, { id, title, workspaceId: project, provider: "codex" });
  await app.open("/");
  await within(await screen.findByRole("navigation", { name: "Threads" })).findAllByRole("link");
  return app;
}
type App = Awaited<ReturnType<typeof openHome>>;
function listed(app: App, id: string) {
  const view = app.daemon.snapshot({ kind: "threads" });
  return view?.kind === "threads" ? view.threads[id] : undefined;
}

/** Pin from the row's context menu, as a person pointing at it would. */
async function pinFromRow(title: RegExp, name: string) {
  await userEvent.pointer({ keys: "[MouseRight]", target: card(title) });
  await userEvent.click(
    await screen.findByRole("menuitem", {
      name: name.startsWith("Unpin") ? /^Unpin/ : /^Pin/,
    }),
  );
}

test("pinned threads lead their project, each new pin first among them", async () => {
  await openHome();
  // Projects come by most recent activity: relay's thread is the newest.
  await waitFor(() =>
    expect(order()).toEqual(["Other project task", "Gamma task", "Beta task", "Alpha task"]),
  );
  await pinFromRow(/^Alpha/, "Pin Alpha task");
  await pinFromRow(/^Beta/, "Pin Beta task");
  await waitFor(() =>
    expect(order()).toEqual(["Other project task", "Beta task", "Alpha task", "Gamma task"]),
  );
  expect(pinnedGroup()).toEqual(["Beta task", "Alpha task"]);
});

test("P on a focused row pins it and P again unpins it, for every device", async () => {
  const app = await openHome();
  await pinFromRow(/^Alpha/, "Pin Alpha task");
  card(/^Gamma/).focus();
  await userEvent.keyboard("p");
  await waitFor(() => expect(pinnedGroup()[0]).toBe("Gamma task"));
  await waitFor(() => expect(listed(app, "gamma")?.pinned).toBe(true));

  card(/^Gamma/).focus();
  await userEvent.keyboard("p");
  await waitFor(() => expect(pinnedGroup()).toEqual(["Alpha task"]));
  await waitFor(() => expect(listed(app, "gamma")?.pinned).toBeFalsy());
  expect(listed(app, "alpha")?.pinned).toBe(true);
});

test("Space picks a pinned row up, arrows choose its place among its project's pins, Space drops it", async () => {
  const app = await openHome();
  await pinFromRow(/^Alpha/, "Pin Alpha task");
  await pinFromRow(/^Beta/, "Pin Beta task");
  await pinFromRow(/^Gamma/, "Pin Gamma task");
  // A pin in another project is no place for these.
  await pinFromRow(/^Other project/, "Pin Other project task");
  await waitFor(() => expect(pinnedGroup()).toEqual(["Gamma task", "Beta task", "Alpha task"]));

  card(/^Gamma/).focus();
  await userEvent.keyboard(" ");
  await waitFor(() => expect(said()).toMatch(/^Moving Gamma.*Pinned, place 1 of 3/));
  await userEvent.keyboard("{ArrowDown}");
  expect(said()).toMatch(/Pinned, place 2 of 3/);
  await userEvent.keyboard("{ArrowDown}");
  expect(said()).toMatch(/Pinned, place 3 of 3/);
  await userEvent.keyboard(" ");

  await waitFor(() => expect(pinnedGroup()).toEqual(["Beta task", "Alpha task", "Gamma task"]));
  expect(said()).toMatch(/^Dropped Gamma/);
  // The daemon keeps the order: its places sort the same way.
  await waitFor(() => {
    const places = ["beta", "alpha", "gamma"].map(
      (id) => listed(app, id)?.pinOrder ?? Number.NaN,
    );
    expect(places).toEqual(places.toSorted((a, b) => b - a));
  });
});

test("Escape puts a keyboard move down where it started", async () => {
  await openHome();
  await pinFromRow(/^Alpha/, "Pin Alpha task");
  await pinFromRow(/^Beta/, "Pin Beta task");
  await waitFor(() => expect(pinnedGroup()).toHaveLength(2));
  const before = pinnedGroup();
  card(/^Beta/).focus();
  await userEvent.keyboard(" ");
  await waitFor(() => expect(said()).toMatch(/^Moving/));
  await userEvent.keyboard("{ArrowDown}{Escape}");
  expect(said()).toBe("Move cancelled");
  expect(pinnedGroup()).toEqual(before);
});

test("moving a pinned thread below its project's pins unpins it, and moving another up pins it", async () => {
  const app = await openHome();
  await pinFromRow(/^Alpha/, "Pin Alpha task");
  await waitFor(() => expect(pinnedGroup()).toHaveLength(1));

  card(/^Alpha/).focus();
  await userEvent.keyboard(" ");
  await waitFor(() => expect(said()).toMatch(/^Moving/));
  await userEvent.keyboard("{ArrowDown}");
  expect(said()).toMatch(/: unpin$/);
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(pinnedGroup()).toEqual([]));
  await waitFor(() => expect(listed(app, "alpha")?.pinned).toBe(false));

  // An unpinned thread starts outside the pins; Up takes it in.
  card(/^Beta/).focus();
  await userEvent.keyboard(" ");
  await waitFor(() => expect(said()).toMatch(/not pinned/));
  await userEvent.keyboard("{ArrowUp} ");
  await waitFor(() => expect(pinnedGroup()).toEqual(["Beta task"]));
});

/** A pinned row's touch drag handle, as a phone shows it. */
const handle = (title: string) => within(threads()).getByRole("button", { name: `Move ${title}` });

test("a pinned row's handle starts a keyboard move with Enter, as Space does on the row", async () => {
  await openHome();
  await pinFromRow(/^Alpha/, "Pin Alpha task");
  await pinFromRow(/^Beta/, "Pin Beta task");
  await waitFor(() => expect(pinnedGroup()).toHaveLength(2));
  // Only pinned rows carry one.
  expect(within(threads()).queryByRole("button", { name: /^Move Gamma/ })).toBeNull();

  handle("Beta task").focus();
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(said()).toMatch(/^Moving Beta.*Pinned, place 1 of 2/));
  await userEvent.keyboard("{ArrowDown} ");
  await waitFor(() => expect(pinnedGroup()).toEqual(["Alpha task", "Beta task"]));
});

test("a finger on a row scrolls the list; a finger on its handle drags it", async () => {
  await openHome();
  await pinFromRow(/^Alpha/, "Pin Alpha task");
  await pinFromRow(/^Beta/, "Pin Beta task");
  await waitFor(() => expect(pinnedGroup()).toHaveLength(2));
  const touch = { pointerId: 7, pointerType: "touch", button: 0, buttons: 1 };

  // Alpha is second among the pins; its handle carries it to the top.
  fireEvent.pointerDown(handle("Alpha task"), {
    ...touch,
    clientX: 200,
    clientY: 120,
  });
  await waitFor(() => {
    fireEvent.pointerMove(window, { ...touch, clientX: 200, clientY: 1 });
    expect(said()).toMatch(/^Moving Alpha/);
  });
  fireEvent.pointerUp(window, { ...touch, clientX: 200, clientY: 1 });
  await waitFor(() => expect(pinnedGroup()).toEqual(["Alpha task", "Beta task"]));
  expect(said()).toBe("Dropped Alpha task: Pinned, place 1 of 2");

  // The same gesture on the row itself, with the drag code loaded, is a scroll: nothing moves.
  fireEvent.pointerDown(card(/^Beta/), { ...touch, clientX: 20, clientY: 120 });
  await act(() => new Promise((settle) => setTimeout(settle, 20)));
  fireEvent.pointerMove(window, { ...touch, clientX: 20, clientY: 1 });
  await act(() => new Promise((settle) => requestAnimationFrame(settle)));
  fireEvent.pointerUp(window, { ...touch, clientX: 20, clientY: 1 });
  expect(said()).toBe("Dropped Alpha task: Pinned, place 1 of 2");
  expect(pinnedGroup()).toEqual(["Alpha task", "Beta task"]);
});
