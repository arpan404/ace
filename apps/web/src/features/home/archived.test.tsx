import { workbench } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

/*
 * The archive (QA-09): an archived thread waits where it can be found again after Undo is gone,
 * and comes back to Home, or goes for good, from there.
 */

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

/** The thread as the daemon's list has it. */
function listed(app: App, id: string) {
  const view = app.daemon.snapshot({ kind: "threads" });
  return view?.kind === "threads" ? view.threads[id] : undefined;
}

/** The daemon still serves the thread; a deleted one is gone from every read. */
function onDaemon(app: App, id: string) {
  return app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse(id) }) !== undefined;
}

/** Archive from the row's menu, as the person would; the daemon has it before the test goes on. */
async function archive(app: App, title: RegExp, id: string) {
  const target = card(title);
  if (!target) throw new Error(`No card for ${title}`);
  await userEvent.pointer({ keys: "[MouseRight]", target });
  const menu = await screen.findByRole("menu", { name: /^Actions for/ });
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Archive" }));
  await waitFor(() => expect(listed(app, id)?.archivedAt).toBeDefined());
}

async function openArchiveFromFilter() {
  await userEvent.click(screen.getByRole("button", { name: /^Project filter/ }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /^Archived threads/ }));
  return screen.findByRole("list", { name: "Archived threads" });
}

test("an archived thread waits in Archived, and Restore brings it back to Home", async () => {
  const app = await openHome();
  await archive(app, /Backpressure/, "thread-fan-out");
  expect(card(/Backpressure/)).toBeNull();

  const archived = await openArchiveFromFilter();
  await userEvent.click(
    within(archived).getByRole("button", { name: "Restore Backpressure on broadcast fan-out" }),
  );
  await waitFor(() => expect(listed(app, "thread-fan-out")?.archivedAt).toBeUndefined());
  expect(await within(threads()).findByRole("link", { name: /Backpressure/ })).toBeTruthy();
  expect(screen.queryByRole("list", { name: "Archived threads" })).toBeNull();
});

test("Delete in Archived asks first, then deletes the thread on the daemon", async () => {
  const app = await openHome();
  await archive(app, /Invoice PDF/, "thread-pdf-locale");
  const archived = await openArchiveFromFilter();

  await userEvent.click(within(archived).getByRole("button", { name: /^Delete Invoice PDF/ }));
  const dialog = await screen.findByRole("dialog", { name: /^Delete “Invoice PDF/ });
  expect(onDaemon(app, "thread-pdf-locale")).toBe(true);
  await userEvent.click(within(dialog).getByRole("button", { name: "Delete thread" }));
  await waitFor(() => expect(onDaemon(app, "thread-pdf-locale")).toBe(false));
  expect(await screen.findByText("Nothing archived")).toBeTruthy();
});

test("⌘K opens the archive, and an archived thread's own menu offers Restore instead of Archive", async () => {
  const app = await openHome();
  await archive(app, /Backpressure/, "thread-fan-out");
  await userEvent.keyboard("{Meta>}k{/Meta}");
  await userEvent.type(
    await screen.findByRole("combobox", { name: "Search commands" }),
    "archived",
  );
  await userEvent.click(await screen.findByRole("option", { name: /^Archived threads/ }));
  const archived = await screen.findByRole("list", { name: "Archived threads" });

  await userEvent.click(within(archived).getByRole("link", { name: /Backpressure/ }));
  await screen.findByRole("heading", { level: 1, name: "Backpressure on broadcast fan-out" });
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  const menu = await screen.findByRole("menu");
  expect(within(menu).queryByRole("menuitem", { name: "Archive" })).toBeNull();
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Restore from archive" }));
  await waitFor(() => expect(listed(app, "thread-fan-out")?.archivedAt).toBeUndefined());
});
