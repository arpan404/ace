import { workbench } from "@ace/fake-daemon";
import { ThreadId, WorkspaceId } from "@ace/protocol";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { fakeClient, harness } from "@/test/harness.tsx";
import { memoryStorage } from "@/boot/client.ts";

beforeEach(() => localStorage.clear());

const threads = () => screen.getByRole("navigation", { name: "Threads" });
const card = (title: RegExp) => within(threads()).queryByRole("link", { name: title });

async function openHome(options: Parameters<typeof harness>[0] = {}) {
  const app = harness(options);
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
  if (item === "Delete thread") {
    const dialog = await screen.findByRole("dialog", { name: "Delete thread?" });
    await userEvent.click(
      within(dialog).getByRole("button", { name: /^(Delete|Stop and delete)$/ }),
    );
  }
}

/** The thread as the daemon's list has it. */
function listed(app: App, id: string) {
  const view = app.daemon.snapshot({ kind: "threads" });
  return view?.kind === "threads" ? view.threads[id] : undefined;
}
/** The row's name says Pinned (the task row's pin mark itself is decoration). */
const pinned = (title: RegExp) => {
  const row = card(title);
  return row !== null && /\bPinned\b/.test(row.getAttribute("aria-label") ?? "");
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

test.each([false, true])(
  "Delete persists before the window closes and stays deleted after reconnect, worker=%s",
  async (throughWorker) => {
    const app = await openHome({ throughWorker });
    await choose(/Invoice PDF/, "Delete thread");
    expect(card(/Invoice PDF/)).toBeNull();
    await waitFor(() => expect(listed(app, "thread-pdf-locale")).toBeUndefined());

    // Closing the window and advancing the old grace period cannot lose the deletion.
    vi.useFakeTimers();
    cleanup();
    await vi.advanceTimersByTimeAsync(6_500);
    vi.useRealTimers();
    const threadId = ThreadId.parse("thread-pdf-locale");
    expect(app.daemon.snapshot({ kind: "thread", threadId })).toBeUndefined();
    expect(listed(app, "thread-pdf-locale")).toBeUndefined();

    // A fresh window sees the persisted tombstone.
    await app.open("/");
    await within(await screen.findByRole("navigation", { name: "Threads" })).findAllByRole("link");
    expect(card(/Invoice PDF/)).toBeNull();
  },
  15_000,
);

test("offline Delete survives closing the window in the durable outbox", async () => {
  const outbox = memoryStorage();
  const app = await openHome({ outbox });
  app.client.networkOnline(false);
  await choose(/Invoice PDF/, "Delete thread");
  expect(card(/Invoice PDF/)).toBeNull();
  await waitFor(async () => expect(await outbox.load()).toContain("thread.delete"));
  cleanup();
  await app.client.close();
  const fresh = fakeClient(app.daemon, app.daemon.token, outbox);
  const lease = fresh.threads();
  try {
    await fresh.start();
    await waitFor(() => expect(fresh.state).toBe("ready"));
    await waitFor(() =>
      expect(
        app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("thread-pdf-locale") }),
      ).toBeUndefined(),
    );
    await waitFor(() => expect(lease.store.thread("thread-pdf-locale")).toBeUndefined());
  } finally {
    lease.release();
    await fresh.close();
  }
});

test("deleting the open thread from the sidebar opens New thread", async () => {
  const app = await openHome();
  await userEvent.click(
    card(/Invoice PDF/) ??
      (() => {
        throw Error("No invoice row");
      })(),
  );
  await screen.findByRole("heading", { level: 1, name: "Invoice PDF locale fallback" });
  await choose(/Invoice PDF/, "Delete thread");
  await waitFor(() => expect(listed(app, "thread-pdf-locale")).toBeUndefined());
  expect(await screen.findByRole("heading", { level: 1, name: "New thread" })).toBeTruthy();
  expect(screen.queryByText("Thread unavailable")).toBeNull();
});

test("deleting another thread and a refused active delete preserve the open thread", async () => {
  const app = await openHome();
  await userEvent.click(
    card(/Invoice PDF/) ??
      (() => {
        throw Error("No invoice row");
      })(),
  );
  await screen.findByRole("heading", { level: 1, name: "Invoice PDF locale fallback" });
  await userEvent.click(await screen.findByRole("button", { name: "Settled 1" }));
  await userEvent.click(
    screen.getByRole("button", { name: "Actions for Bump Codex app-server to 0.48" }),
  );
  await userEvent.click(await screen.findByRole("menuitem", { name: "Unsettle" }));
  await waitFor(() => expect(card(/Bump Codex/)).toBeTruthy());
  await choose(/Bump Codex/, "Delete thread");
  await waitFor(() => expect(listed(app, "thread-bump-codex")).toBeUndefined());
  expect(
    screen.getByRole("heading", { level: 1, name: "Invoice PDF locale fallback" }),
  ).toBeTruthy();
  app.daemon.refuseCommands("forbidden", "thread.delete");
  await choose(/Invoice PDF/, "Delete thread");
  expect(await screen.findByText("Couldn't delete the thread")).toBeTruthy();
  expect(
    screen.getByRole("heading", { level: 1, name: "Invoice PDF locale fallback" }),
  ).toBeTruthy();
});

test("a delivered create never returns as a starting row after deleting its thread", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/new?project=relay");
  await userEvent.type(
    await screen.findByRole("combobox", { name: "Message" }),
    "Temporary thread for deletion{Enter}",
  );
  await waitFor(() =>
    expect(
      app.client
        .pendingSends()
        .getSnapshot()
        ?.some((send) => send.state === "delivered" && send.payload.type === "thread.create"),
    ).toBe(true),
  );
  await waitFor(() => expect(card(/^Temporary thread for deletion/)).toBeTruthy());
  await waitFor(() => expect(screen.queryByRole("list", { name: "Starting threads" })).toBeNull());
  await choose(/^Temporary thread for deletion/, "Delete thread");
  await screen.findByText("Deleted · Temporary thread for deletion");
  await waitFor(() => expect(screen.queryByRole("list", { name: "Starting threads" })).toBeNull());
  expect(card(/^Temporary thread for deletion/)).toBeNull();
  expect(await screen.findByRole("heading", { level: 1, name: "New thread" })).toBeTruthy();
});

test.each([false, true])(
  "an accepted create listed without its transcript stays gone after deletion, worker=%s",
  async (throughWorker) => {
    const app = await openHome({ throughWorker });
    await userEvent.click(
      card(/Invoice PDF/) ??
        (() => {
          throw Error("No invoice row");
        })(),
    );
    await screen.findByRole("heading", { level: 1, name: "Invoice PDF locale fallback" });
    const result = await app.client.command({
      type: "thread.create",
      workspaceId: WorkspaceId.parse("relay"),
      provider: "codex",
      input: [{ type: "text", text: "Accepted thread without a transcript" }],
    });
    expect(result.ok).toBe(true);
    await waitFor(() => expect(card(/^Accepted thread without a transcript/)).toBeTruthy());
    expect(app.client.pendingSends().getSnapshot()).toContainEqual(
      expect.objectContaining({ threadId: result.threadId, state: "accepted" }),
    );
    if (!result.threadId) throw Error("No created thread ID");
    // A bulk or another-device delete doesn't open the single-row menu's transcript lease.
    expect(
      await app.client.command({ type: "thread.delete", threadId: result.threadId, force: true }),
    ).toMatchObject({ ok: true });
    await waitFor(() => expect(card(/^Accepted thread without a transcript/)).toBeNull());
    expect(screen.queryByRole("list", { name: "Starting threads" })).toBeNull();
  },
);
