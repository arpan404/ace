import { workbench } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

const threads = () => screen.getByRole("navigation", { name: "Threads" });
const card = (title: RegExp) => within(threads()).getByRole("link", { name: title });
const gone = (title: RegExp) => within(threads()).queryByRole("link", { name: title }) === null;
const bar = () => screen.getByRole("toolbar", { name: "Selected threads" });

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

async function pick(title: RegExp, keys: "{Meta>}" | "{Shift>}") {
  const user = userEvent.setup();
  await user.keyboard(keys);
  await user.click(card(title));
  await user.keyboard(keys === "{Meta>}" ? "{/Meta}" : "{/Shift}");
}

test("⌘-click picks rows without opening them, Shift-click takes the rows between", async () => {
  const app = await openHome();
  const opened = window.location.pathname;
  await pick(/^Approval sheet/, "{Meta>}");
  await pick(/^Backpressure/, "{Shift>}");
  expect(window.location.pathname).toBe(opened);
  expect(await screen.findByText("3 selected")).toBeTruthy();
  expect(card(/^Retry budget.*, selected/)).toBeTruthy();
  expect(
    within(threads()).queryByRole("link", { name: /^Partial refunds.*, selected/ }),
  ).toBeNull();

  // Pin pins them all, keeping the order they were listed in.
  await userEvent.click(within(bar()).getByRole("button", { name: "Pin 3 threads" }));
  await waitFor(() =>
    expect(
      ["thread-sheet-rotate", "thread-retry-budget", "thread-fan-out"].map(
        (id) => listed(app, id)?.pinned,
      ),
    ).toEqual([true, true, true]),
  );
  expect(screen.queryByRole("toolbar", { name: "Selected threads" })).toBeNull();
});

test("bulk Archive asks first, then archives every picked thread, and one Undo restores them", async () => {
  const app = await openHome();
  await pick(/^Backpressure/, "{Meta>}");
  await pick(/^Invoice PDF/, "{Meta>}");
  await userEvent.click(within(bar()).getByRole("button", { name: "Archive 2 threads…" }));
  const dialog = await screen.findByRole("dialog", { name: "Archive 2 threads?" });
  expect(within(dialog).getByText("Backpressure on broadcast fan-out")).toBeTruthy();
  // Cancel has focus: Enter alone never archives.
  await waitFor(() =>
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" })),
  );
  await userEvent.click(within(dialog).getByRole("button", { name: "Archive 2 threads" }));

  await waitFor(() => expect(gone(/^Backpressure/) && gone(/^Invoice PDF/)).toBe(true));
  await waitFor(() => expect(listed(app, "thread-fan-out")?.archivedAt).toBeDefined());
  await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
  await waitFor(() => expect(listed(app, "thread-fan-out")?.archivedAt).toBeUndefined());
  await waitFor(() => expect(listed(app, "thread-pdf-locale")?.archivedAt).toBeUndefined());
});

test("cancelling a bulk Delete keeps every thread", async () => {
  const app = await openHome();
  await pick(/^Backpressure/, "{Meta>}");
  await pick(/^Invoice PDF/, "{Meta>}");
  await userEvent.click(within(bar()).getByRole("button", { name: "Delete 2 threads…" }));
  const dialog = await screen.findByRole("dialog", { name: "Delete 2 threads?" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(gone(/^Backpressure/)).toBe(false);
  expect(listed(app, "thread-fan-out")?.archivedAt).toBeUndefined();
  // Still picked: the person can choose something else.
  expect(screen.getByText("2 selected")).toBeTruthy();
});

test("a picked row's context menu acts on every picked thread", async () => {
  const app = await openHome();
  await pick(/^Backpressure/, "{Meta>}");
  await pick(/^Invoice PDF/, "{Meta>}");
  await userEvent.pointer({ keys: "[MouseRight]", target: card(/^Invoice PDF/) });
  const menu = await screen.findByRole("menu", { name: "Actions for the selected threads" });
  await userEvent.click(await within(menu).findByRole("menuitem", { name: "Pin 2 threads" }));
  await waitFor(() => expect(listed(app, "thread-fan-out")?.pinned).toBe(true));
  await waitFor(() => expect(listed(app, "thread-pdf-locale")?.pinned).toBe(true));
});

test("X picks the focused row, Shift+↓ extends the pick, and Escape lets it go", async () => {
  await openHome();
  card(/^Approval sheet/).focus();
  await userEvent.keyboard("x");
  expect(await screen.findByText("1 selected")).toBeTruthy();
  await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
  expect(await screen.findByText("2 selected")).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("toolbar", { name: "Selected threads" })).toBeNull(),
  );
});

test("⌘K offers the picked threads' actions first, and asks before deleting them", async () => {
  const app = await openHome();
  await pick(/^Backpressure/, "{Meta>}");
  await pick(/^Invoice PDF/, "{Meta>}");
  await userEvent.keyboard("{Meta>}k{/Meta}");
  const group = await screen.findByRole("group", { name: "Selected threads" });
  const names = within(group)
    .getAllByRole("option")
    .map((option) => option.textContent ?? "");
  expect(names).toEqual([
    "Pin 2 selected threads",
    "Archive 2 selected threads…",
    "Delete 2 selected threads…",
    "Clear the selection",
  ]);
  await userEvent.click(within(group).getByRole("option", { name: /^Delete 2/ }));
  const dialog = await screen.findByRole("dialog", { name: "Delete 2 threads?" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Delete 2 threads" }));
  // Hidden at once on every device; deleted for good once the Undo toast goes.
  await waitFor(() => expect(gone(/^Backpressure/) && gone(/^Invoice PDF/)).toBe(true));
  await waitFor(() => expect(listed(app, "thread-fan-out")?.archivedAt).toBeDefined());
});
