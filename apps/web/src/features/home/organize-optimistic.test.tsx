import { workbench } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

const threads = () => screen.getByRole("navigation", { name: "Threads" });
const card = (title: RegExp) => within(threads()).queryByRole("link", { name: title });

async function openHome() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/");
  await within(await screen.findByRole("navigation", { name: "Threads" })).findAllByRole("link");
  return app;
}
type App = Awaited<ReturnType<typeof openHome>>;

async function choose(title: RegExp, item: string | RegExp) {
  const target = card(title);
  if (!target) throw new Error(`No card for ${title}`);
  await userEvent.pointer({ keys: "[MouseRight]", target });
  const menu = await screen.findByRole("menu", { name: /^Actions for/ });
  await userEvent.click(within(menu).getByRole("menuitem", { name: item }));
}

/** The thread as the daemon's list has it. */
function listed(app: App, id: string) {
  const view = app.daemon.snapshot({ kind: "threads" });
  return view?.kind === "threads" ? view.threads[id] : undefined;
}
/** The row's name says Pinned (the task row's pin mark itself is decoration). */
const pinned = (title: RegExp) => {
  const row = card(title);
  return row !== null && /\bPinned\b/.test(row.textContent ?? "");
};

test("offline, Archive hides the thread at once, says it will apply, and applies on reconnect", async () => {
  const app = await openHome();
  app.client.networkOnline(false);
  await choose(/Backpressure/, "Archive");

  expect(card(/Backpressure/)).toBeNull();
  const toast = await screen.findByText("Archived · Backpressure on broadcast fan-out");
  expect(toast.closest("[role]")?.textContent).toContain("Will apply when reconnected");
  expect(listed(app, "thread-fan-out")?.archivedAt).toBeUndefined();

  app.client.networkOnline(true);
  await waitFor(() => expect(listed(app, "thread-fan-out")?.archivedAt).toBeDefined());
  expect(card(/Backpressure/)).toBeNull();
});

test("offline, Pin shows the pin at once and the daemon keeps it after the reconnect", async () => {
  const app = await openHome();
  app.client.networkOnline(false);
  await choose(/Backpressure/, /^Pin/);
  expect(pinned(/Backpressure/)).toBe(true);
  expect(listed(app, "thread-fan-out")?.pinned).not.toBe(true);

  app.client.networkOnline(true);
  await waitFor(() => expect(listed(app, "thread-fan-out")?.pinned).toBe(true));
  expect(pinned(/Backpressure/)).toBe(true);
});

test("a pin the daemon refuses comes off again, with a toast that says why", async () => {
  const app = await openHome();
  app.daemon.refuseCommands("forbidden", "thread.pin");
  await choose(/Backpressure/, /^Pin/);

  expect(await screen.findByText("Couldn't pin the thread")).toBeTruthy();
  expect(screen.getByText("This device isn't allowed to do that.")).toBeTruthy();
  await waitFor(() => expect(pinned(/Backpressure/)).toBe(false));
});

test("Mark unread shows at once and a refusal puts the row back as read", async () => {
  const app = await openHome();
  app.client.networkOnline(false);
  await choose(/Backpressure/, "Mark unread");
  expect(card(/Backpressure.*, unread/)).toBeTruthy();

  app.daemon.refuseCommands("forbidden", "thread.read");
  app.client.networkOnline(true);
  expect(await screen.findByText("Couldn't mark the thread unread")).toBeTruthy();
  await waitFor(() => expect(card(/Backpressure.*, unread/)).toBeNull());
});

test("a rename the daemon refuses opens the field again with the typed title", async () => {
  const app = await openHome();
  app.daemon.refuseCommands("forbidden", "thread.rename");
  await choose(/Retry budget/, /Rename/);
  const field = await screen.findByRole("textbox", { name: "Thread title" });
  await waitFor(() => expect(document.activeElement).toBe(field));
  await userEvent.clear(field);
  await userEvent.type(field, "Cap app-server restarts{Enter}");

  expect(await screen.findByText("Couldn't rename the thread")).toBeTruthy();
  const again = await screen.findByRole("textbox", { name: "Thread title" });
  expect(again).toHaveProperty("value", "Cap app-server restarts");

  // Saving again once the daemon takes it.
  app.daemon.restoreRequests();
  await waitFor(() => expect(document.activeElement).toBe(again));
  await userEvent.type(again, "{Enter}");
  expect(
    await within(threads()).findByRole("link", { name: /^Cap app-server restarts/ }),
  ).toBeTruthy();
  await waitFor(() =>
    expect(listed(app, "thread-retry-budget")?.title).toBe("Cap app-server restarts"),
  );
});

test("Delete archives at once, so a window closed within Undo leaves it archived, not lost", async () => {
  const app = await openHome();
  await choose(/Invoice PDF/, "Delete thread");
  expect(card(/Invoice PDF/)).toBeNull();
  await waitFor(() => expect(listed(app, "thread-pdf-locale")?.archivedAt).toBeDefined());

  // The window goes away inside the Undo window; then the Undo window passes (on a fake clock,
  // so a delete still scheduled anywhere would fire here).
  vi.useFakeTimers();
  cleanup();
  await vi.advanceTimersByTimeAsync(6_500);
  vi.useRealTimers();
  const threadId = ThreadId.parse("thread-pdf-locale");
  expect(app.daemon.snapshot({ kind: "thread", threadId })).toBeDefined();
  expect(listed(app, "thread-pdf-locale")?.archivedAt).toBeDefined();

  // Every other window already shows it gone.
  await app.open("/");
  await within(await screen.findByRole("navigation", { name: "Threads" })).findAllByRole("link");
  expect(card(/Invoice PDF/)).toBeNull();
}, 15_000);
