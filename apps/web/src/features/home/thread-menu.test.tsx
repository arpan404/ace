import { workbench } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { configure, cleanup, screen, waitFor, within } from "@testing-library/react";

import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { archiveStoppingCommands } from "@/test/archive-question.ts";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

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

test("Rename from the menu opens the shared title field; Escape keeps the old one", async () => {
  await openHome();
  let menu = await rightClick(/Backpressure/);
  await userEvent.click(within(menu).getByRole("menuitem", { name: /Rename/ }));
  const field = await screen.findByRole("textbox", { name: "Thread title" });
  await waitFor(() => expect(document.activeElement).toBe(field));
  await userEvent.clear(field);
  await userEvent.type(field, "Bound broadcast fan-out{Enter}");
  expect(
    await within(threads()).findByRole("link", { name: /Bound broadcast fan-out/ }),
  ).toBeTruthy();

  menu = await rightClick(/Bound broadcast fan-out/);
  await userEvent.keyboard("{Alt>}{Meta>}r{/Meta}{/Alt}");
  const again = await screen.findByRole("textbox", { name: "Thread title" });
  await userEvent.type(again, " later{Escape}");
  expect(
    await within(threads()).findByRole("link", { name: /Bound broadcast fan-out/ }),
  ).toBeTruthy();
  expect(card(/fan-out later/)).toBeNull();
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

test("a finished thread marked unread reads unread in its row, and opening it marks it read", async () => {
  await openHome();
  const menu = await rightClick(/Invoice PDF/);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Mark unread" }));
  await waitFor(() => expect(card(/^Invoice PDF.*, unread/)).toBeTruthy());
  const unread = card(/^Invoice PDF.*, unread/);
  if (!unread) throw new Error("Missing the unread row");
  await userEvent.click(unread);
  await waitFor(() => expect(card(/^Invoice PDF.*, unread/)).toBeNull());
  expect(card(/^Invoice PDF/)).toBeTruthy();
});

/** The daemon still serves the thread; a deleted one is gone from every read. */
function onDaemon(app: Awaited<ReturnType<typeof openHome>>, id: string) {
  return app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse(id) }) !== undefined;
}

test("Delete hides the thread and permanently deletes it on the daemon", async () => {
  const app = await openHome();
  const menu = await rightClick(/Invoice PDF/);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Delete thread" }));
  await userEvent.click(
    within(await screen.findByRole("dialog", { name: "Delete thread?" })).getByRole("button", {
      name: "Delete",
    }),
  );
  await waitFor(() => expect(card(/Invoice PDF/)).toBeNull());
  await waitFor(() => expect(onDaemon(app, "thread-pdf-locale")).toBe(false));
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
});

test("Delete stays gone when the client reconnects", async () => {
  const app = await openHome();
  const menu = await rightClick(/Invoice PDF/);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Delete thread" }));
  await userEvent.click(
    within(await screen.findByRole("dialog", { name: "Delete thread?" })).getByRole("button", {
      name: "Delete",
    }),
  );
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
  // It replied with its soak test left running (ADR 0116): archiving stops that, so it asks.
  await archiveStoppingCommands();
  await waitFor(() => expect(card(/Backpressure/)).toBeNull());
  expect(await screen.findByText("Archived · Backpressure on broadcast fan-out")).toBeTruthy();
  await waitFor(() => expect(archivedAt()).toBeDefined());

  await userEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(card(/Backpressure/)).toBeTruthy());
  expect(archivedAt()).toBeUndefined();
});

test("a running thread refused for delete stays listed, says what runs, and Stop and delete removes it", async () => {
  const app = await openHome();
  const menu = await rightClick(/Dedupe thread events/);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Delete thread" }));
  const confirmation = await screen.findByRole("dialog", { name: "Delete thread?" });
  expect(confirmation.textContent).toMatch(/agent.*running/);
  await userEvent.click(screen.getByRole("button", { name: "Stop and delete" }));
  await waitFor(() => expect(card(/Dedupe thread events/)).toBeNull());
  await waitFor(() => expect(onDaemon(app, "thread-dedupe")).toBe(false));
}, 15_000);

test("New thread from default branch starts from the project's own default branch, not main", async () => {
  const app = await openHome();
  app.daemon.workspace.git.setDefaultBranch("billing-api", "develop");
  const menu = await rightClick(/Invoice PDF/);
  await userEvent.click(
    within(menu).getByRole("menuitem", { name: /New thread from default branch/ }),
  );
  await screen.findByRole("heading", { level: 1, name: "New thread" });
  expect(await screen.findByRole("button", { name: "Project: billing-api" })).toBeTruthy();
  // The default branch at its freshest: its upstream copy.
  expect(await screen.findByRole("button", { name: "Start from: origin/develop" })).toBeTruthy();
});

test("people link pull requests from the thread menu and confirm before unlinking all", async () => {
  const app = await openHome();
  let menu = await rightClick(/Rewrite the install page/);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Link pull request…" }));
  const dialog = await screen.findByRole("dialog", { name: "Link pull request" });
  await userEvent.type(
    within(dialog).getByRole("textbox", { name: "Link pull request…" }),
    "#283{Enter}",
  );
  await waitFor(() => {
    const snapshot = app.daemon.snapshot({
      kind: "thread",
      threadId: ThreadId.parse("thread-install-page"),
    });
    expect(
      snapshot &&
        "thread" in snapshot &&
        snapshot.thread.details?.linkedPrs?.some((pr) => pr.number === 283),
    ).toBe(true);
  });
  menu = await rightClick(/Rewrite the install page/);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Unlink all pull requests" }));
  const confirmation = await screen.findByRole("dialog", { name: "Unlink all pull requests?" });
  await userEvent.click(within(confirmation).getByRole("button", { name: "Unlink all" }));
  await waitFor(() => {
    const snapshot = app.daemon.snapshot({
      kind: "thread",
      threadId: ThreadId.parse("thread-install-page"),
    });
    expect(snapshot && "thread" in snapshot && snapshot.thread.details?.linkedPrs).toEqual([]);
  });
});
