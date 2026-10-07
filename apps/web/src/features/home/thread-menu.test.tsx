import { workbench } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

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

test("Mark unread and Pin are kept by the daemon, so the list shows them after a reload", async () => {
  const app = await openHome();
  let menu = await rightClick(/Backpressure/);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Mark unread" }));
  await waitFor(() => expect(card(/Backpressure.*, unread/)).toBeTruthy());

  menu = await rightClick(/Backpressure/);
  expect(within(menu).getByRole("menuitem", { name: "Mark read" })).toBeTruthy();
  await userEvent.click(within(menu).getByRole("menuitem", { name: /^Pin/ }));
  await waitFor(() => expect(card(/Backpressure.*Pinned/)).toBeTruthy());
  const view = app.daemon.snapshot({ kind: "threads" });
  expect(view?.kind === "threads" && view.threads["thread-fan-out"]).toMatchObject({
    pinned: true,
    unread: true,
  });
  cleanup();

  // Another window on the same daemon sees both.
  await app.open("/");
  await within(await screen.findByRole("navigation", { name: "Threads" })).findAllByRole("link");
  await waitFor(() => expect(card(/Backpressure.*, unread.*Pinned/)).toBeTruthy());
  menu = await rightClick(/Backpressure/);
  expect(within(menu).getByRole("menuitem", { name: /^Unpin/ })).toBeTruthy();
});

test("opening an unread thread marks it read", async () => {
  await openHome();
  const menu = await rightClick(/Invoice PDF/);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Mark unread" }));
  const unread = await waitFor(() => {
    const link = card(/, unread/);
    if (!link) throw new Error("not unread yet");
    return link;
  });
  await userEvent.click(unread);
  await waitFor(() => expect(card(/, unread/)).toBeNull());
});

/** The daemon still serves the thread; a deleted one is gone from every read. */
function onDaemon(app: Awaited<ReturnType<typeof openHome>>, id: string) {
  return app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse(id) }) !== undefined;
}

test("Delete hides the thread and permanently deletes it on the daemon", async () => {
  const app = await openHome();
  const menu = await rightClick(/Invoice PDF/);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Delete thread" }));
  await waitFor(() => expect(card(/Invoice PDF/)).toBeNull());
  await waitFor(() => expect(onDaemon(app, "thread-pdf-locale")).toBe(false));
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
});

test("Delete stays gone when the client reconnects", async () => {
  const app = await openHome();
  const menu = await rightClick(/Invoice PDF/);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Delete thread" }));
  await waitFor(() => expect(card(/Invoice PDF/)).toBeNull());
  await waitFor(() => expect(onDaemon(app, "thread-pdf-locale")).toBe(false), {
    timeout: 9_000,
  });
  app.client.networkOnline(false);
  app.client.networkOnline(true);
  await waitFor(() => expect(app.client.state).toBe("ready"));
  expect(card(/Invoice PDF/)).toBeNull();
}, 15_000);

test("Archive takes effect on the daemon at once and Undo unarchives it", async () => {
  const app = await openHome();
  const archivedAt = () => {
    const view = app.daemon.snapshot({ kind: "threads" });
    return view?.kind === "threads" ? view.threads["thread-fan-out"]?.archivedAt : undefined;
  };
  const menu = await rightClick(/Backpressure/);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Archive" }));
  await waitFor(() => expect(card(/Backpressure/)).toBeNull());
  expect(await screen.findByText("Archived · Backpressure on broadcast fan-out")).toBeTruthy();
  await waitFor(() => expect(archivedAt()).toBeDefined());

  await userEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(card(/Backpressure/)).toBeTruthy());
  expect(archivedAt()).toBeUndefined();
});

test("a thread the daemon won't delete stays in the list and says why", async () => {
  await openHome();
  const menu = await rightClick(/Dedupe thread events/);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Delete thread" }));
  expect(
    await screen.findByText("Stop its agents and close its terminals first.", undefined, {
      timeout: 9_000,
    }),
  ).toBeTruthy();
  await waitFor(() => expect(card(/Dedupe thread events/)).toBeTruthy());
}, 15_000);

test("New thread on main starts a thread in the same project", async () => {
  await openHome();
  const menu = await rightClick(/Partial refunds/);
  await userEvent.click(within(menu).getByRole("menuitem", { name: /New thread on main/ }));
  await screen.findByRole("heading", { level: 1, name: "New thread" });
  expect(await screen.findByRole("button", { name: "Project: billing-api" })).toBeTruthy();
  expect(await screen.findByRole("button", { name: "Start from: main" })).toBeTruthy();
});
