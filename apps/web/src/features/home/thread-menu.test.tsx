import { workbench } from "@ace/fake-daemon";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

const threads = () => screen.getByRole("navigation", { name: "Threads" });
const card = (title: RegExp) => within(threads()).queryByRole("link", { name: title });

async function openHome(options: Parameters<typeof harness>[0] = {}) {
  const app = harness(options);
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/");
  await within(await screen.findByRole("navigation", { name: "Threads" })).findAllByRole("link");
  return app;
}

async function rightClick(title: RegExp) {
  const target = card(title);
  if (!target) throw new Error(`No card for ${title}`);
  await userEvent.pointer({ keys: "[MouseRight]", target });
  return screen.findByRole("menu", { name: /^Actions for/ });
}

test("Rename from the menu edits the title in place; Escape keeps the old one", async () => {
  await openHome();
  let menu = await rightClick(/Retry budget/);
  await userEvent.click(within(menu).getByRole("menuitem", { name: /Rename/ }));
  const field = await screen.findByRole("textbox", { name: "Thread title" });
  await waitFor(() => expect(document.activeElement).toBe(field));
  await userEvent.clear(field);
  await userEvent.type(field, "Cap app-server restarts{Enter}");
  expect(
    await within(threads()).findByRole("link", { name: /Cap app-server restarts/ }),
  ).toBeTruthy();

  menu = await rightClick(/Cap app-server restarts/);
  await userEvent.keyboard("r");
  const again = await screen.findByRole("textbox", { name: "Thread title" });
  await userEvent.type(again, " later{Escape}");
  expect(
    await within(threads()).findByRole("link", { name: /Cap app-server restarts/ }),
  ).toBeTruthy();
  expect(card(/restarts later/)).toBeNull();
});

test("Mark unread, Pin and their opposites follow the thread's state", async () => {
  const storage = memoryKeyValue();
  await openHome({ storage });
  let menu = await rightClick(/Backpressure/);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Mark unread" }));
  await waitFor(() => expect(card(/Backpressure.*, unread/)).toBeTruthy());

  menu = await rightClick(/Backpressure/);
  expect(within(menu).getByRole("menuitem", { name: "Mark read" })).toBeTruthy();
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Pin" }));
  await waitFor(() =>
    expect(
      within(card(/Backpressure/) ?? threads()).getByRole("img", { name: "Pinned" }),
    ).toBeTruthy(),
  );
  cleanup();

  // Both survive a reload.
  await openHome({ storage });
  expect(
    within(card(/Backpressure.*, unread/) ?? threads()).getByRole("img", { name: "Pinned" }),
  ).toBeTruthy();
  menu = await rightClick(/Backpressure/);
  expect(within(menu).getByRole("menuitem", { name: "Unpin" })).toBeTruthy();
});

test("opening an unread thread marks it read", async () => {
  await openHome();
  const menu = await rightClick(/Bump Codex|Invoice PDF/);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Mark unread" }));
  const unread = await waitFor(() => {
    const link = card(/, unread/);
    if (!link) throw new Error("not unread yet");
    return link;
  });
  await userEvent.click(unread);
  await waitFor(() => expect(card(/, unread/)).toBeNull());
});

test("Delete hides the thread with Undo; Archive tells the daemon once Undo has passed", async () => {
  const app = await openHome();
  let menu = await rightClick(/Invoice PDF/);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Delete thread" }));
  await waitFor(() => expect(card(/Invoice PDF/)).toBeNull());
  await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
  await waitFor(() => expect(card(/Invoice PDF/)).toBeTruthy());

  menu = await rightClick(/Backpressure/);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Archive" }));
  await waitFor(() => expect(card(/Backpressure/)).toBeNull());
  expect(await screen.findByText("Archived · Backpressure on broadcast fan-out")).toBeTruthy();
  const archivedAt = () => {
    const view = app.daemon.snapshot({ kind: "threads" });
    return view?.kind === "threads" ? view.threads["thread-fan-out"]?.archivedAt : undefined;
  };
  expect(archivedAt()).toBeUndefined();
  await waitFor(() => expect(archivedAt()).toBeDefined(), { timeout: 9_000 });
  expect(card(/Backpressure/)).toBeNull();
}, 15_000);

test("Undoing an archive keeps the thread on the daemon untouched", async () => {
  const app = await openHome();
  const menu = await rightClick(/Backpressure/);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Archive" }));
  await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
  await waitFor(() => expect(card(/Backpressure/)).toBeTruthy());
  await waitFor(() => expect(screen.queryByText(/^Archived ·/)).toBeNull(), { timeout: 9_000 });
  const view = app.daemon.snapshot({ kind: "threads" });
  expect(view?.kind === "threads" && view.threads["thread-fan-out"]?.archivedAt).toBeUndefined();
}, 15_000);

test("New thread on main starts a thread in the same project", async () => {
  await openHome();
  const menu = await rightClick(/Partial refunds/);
  await userEvent.click(within(menu).getByRole("menuitem", { name: /New thread on main/ }));
  await screen.findByRole("heading", { level: 1, name: "New thread" });
  expect(
    screen.getByRole("heading", { level: 2, name: "What should we work on in billing-api?" }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Start from branch: from main" })).toBeTruthy();
});
