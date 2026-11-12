import { createIdleTask } from "@/test/tasks.ts";
import { workbench } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { act, cleanup, configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";
import { toastTimeouts } from "@/components/ui/toast.tsx";
import { undoWindowMs } from "@/features/organize/use-thread-actions.ts";

configure({ asyncUtilTimeout: 10000 });
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

/** Home with two completed tasks, so the daemon lets them be deleted. */
async function openWithIdle() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  for (const [id, title] of [
    ["thread-readme", "Tidy the README"],
    ["thread-docs-index", "Sketch the docs index"],
  ] as const)
    createIdleTask(app.daemon, { id, workspaceId: "relay", title, provider: "codex" });
  await app.open("/");
  await within(await screen.findByRole("navigation", { name: "Threads" })).findAllByRole("link");
  return app;
}

/** Whether the daemon still has the thread at all. */
function onDaemon(app: App, id: string) {
  return app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse(id) }) !== undefined;
}
/** The longest any toast here stays up. */
const toastLife = Math.max(undoWindowMs, toastTimeouts.plain, toastTimeouts.action);

async function pick(title: RegExp, keys: "{Meta>}" | "{Shift>}") {
  const user = userEvent.setup();
  await user.keyboard(keys);
  await user.click(card(title));
  await user.keyboard(keys === "{Meta>}" ? "{/Meta}" : "{/Shift}");
}

test("⌘-click picks rows without opening them, Shift-click takes the rows between", async () => {
  const app = await openHome();
  const opened = window.location.pathname;
  await pick(/^Dedupe thread events/, "{Meta>}");
  await pick(/^Backpressure on broadcast/, "{Shift>}");
  expect(window.location.pathname).toBe(opened);
  // In the Inbox's order: the dedupe and the install page run, then the fan-out, done with its
  // soak test left running (ADR 0116), then the invoice fallback.
  expect(await screen.findByText("3 selected")).toBeTruthy();
  expect(card(/^Rewrite the install page.*, selected/)).toBeTruthy();
  expect(
    within(threads()).queryByRole("link", { name: /^Invoice PDF locale fallback.*, selected/ }),
  ).toBeNull();

  // Pin pins them all, keeping the order they were listed in.
  await userEvent.click(within(bar()).getByRole("button", { name: "Pin 3 threads" }));
  await waitFor(() =>
    expect(
      ["thread-dedupe", "thread-install-page", "thread-fan-out"].map(
        (id) => listed(app, id)?.pinned,
      ),
    ).toEqual([true, true, true]),
  );
  expect(listed(app, "thread-pdf-locale")?.pinned).toBeUndefined();
  expect(screen.queryByRole("toolbar", { name: "Selected threads" })).toBeNull();
});

test("bulk Archive archives every picked thread without asking, and one Undo restores them", async () => {
  const app = await openHome();
  // The install page's agent still works: one archive of many never stops to ask about it.
  await pick(/^Rewrite the install page/, "{Meta>}");
  await pick(/^Invoice PDF/, "{Meta>}");
  await userEvent.click(within(bar()).getByRole("button", { name: "Archive 2 threads" }));

  await waitFor(() => expect(gone(/^Rewrite the install page/) && gone(/^Invoice PDF/)).toBe(true));
  expect(screen.queryByRole("dialog", { name: "Archive a running thread?" })).toBeNull();
  await waitFor(() => expect(listed(app, "thread-install-page")?.archivedAt).toBeDefined());
  await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
  await waitFor(() => expect(listed(app, "thread-install-page")?.archivedAt).toBeUndefined());
  await waitFor(() => expect(listed(app, "thread-pdf-locale")?.archivedAt).toBeUndefined());
});

test("bulk Archive with a thread that left a command running asks first, and Archive archives them all", async () => {
  const app = await openHome();
  // The fan-out replied with its soak test still running (ADR 0116): archiving stops it.
  await pick(/^Backpressure on broadcast/, "{Meta>}");
  await pick(/^Invoice PDF/, "{Meta>}");
  await userEvent.click(within(bar()).getByRole("button", { name: "Archive 2 threads" }));

  const ask = await screen.findByRole("dialog", { name: "Archive 2 threads?" });
  expect(within(ask).getByText("Archiving stops 1 command they left running.")).toBeTruthy();
  expect(listed(app, "thread-fan-out")?.archivedAt).toBeUndefined();
  expect(listed(app, "thread-pdf-locale")?.archivedAt).toBeUndefined();

  await userEvent.click(within(ask).getByRole("button", { name: "Archive" }));
  await waitFor(() => expect(listed(app, "thread-fan-out")?.archivedAt).toBeDefined());
  await waitFor(() => expect(listed(app, "thread-pdf-locale")?.archivedAt).toBeDefined());
});

test("cancelling a bulk Archive that would stop a command keeps every thread", async () => {
  const app = await openHome();
  await pick(/^Backpressure on broadcast/, "{Meta>}");
  await pick(/^Invoice PDF/, "{Meta>}");
  await userEvent.click(within(bar()).getByRole("button", { name: "Archive 2 threads" }));
  const ask = await screen.findByRole("dialog", { name: "Archive 2 threads?" });
  await userEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(listed(app, "thread-fan-out")?.archivedAt).toBeUndefined();
  expect(listed(app, "thread-pdf-locale")?.archivedAt).toBeUndefined();
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
  await openWithIdle();
  // relay's two quiet threads sit next to each other: start from the upper one.
  const upper = within(threads())
    .getAllByRole("link")
    .find((link) =>
      /^(Tidy the README|Sketch the docs index)/.test(link.getAttribute("aria-label") ?? ""),
    );
  if (!upper) throw new Error("No quiet relay thread");
  upper.focus();
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
  const app = await openWithIdle();
  await pick(/^Tidy the README/, "{Meta>}");
  await pick(/^Sketch the docs index/, "{Meta>}");
  await userEvent.keyboard("{Meta>}k{/Meta}");
  const group = await screen.findByRole("group", { name: "Selected threads" });
  const names = within(group)
    .getAllByRole("option")
    .map((option) => option.textContent ?? "");
  expect(names).toEqual([
    "Pin 2 selected threads",
    "Move 2 selected threads to another project…",
    "Archive 2 selected threads",
    "Delete 2 selected threads…",
    "Clear the selection",
  ]);
  await userEvent.click(within(group).getByRole("option", { name: /^Delete 2/ }));
  const dialog = await screen.findByRole("dialog", { name: "Delete 2 threads?" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Delete 2 threads" }));
  await waitFor(() =>
    expect(gone(/^Tidy the README/) && gone(/^Sketch the docs index/)).toBe(true),
  );
  // Deleted on the daemon at once, with nothing to undo.
  await waitFor(() => expect(onDaemon(app, "thread-docs-index")).toBe(false));
  await waitFor(() => expect(onDaemon(app, "thread-readme")).toBe(false));
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
});

test("threads deleted in bulk never come back: not after a while, not after a reload", async () => {
  const app = await openWithIdle();
  await pick(/^Tidy the README/, "{Meta>}");
  await pick(/^Sketch the docs index/, "{Meta>}");
  await userEvent.click(within(bar()).getByRole("button", { name: "Delete 2 threads…" }));
  const dialog = await screen.findByRole("dialog", { name: "Delete 2 threads?" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Delete 2 threads" }));
  await waitFor(() => expect(onDaemon(app, "thread-readme")).toBe(false));
  // Past every toast's life: nothing waits on one to finish the delete or to undo it.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    act(() => vi.advanceTimersByTime(toastLife + 500));
  } finally {
    vi.useRealTimers();
  }
  expect(gone(/^Tidy the README/) && gone(/^Sketch the docs index/)).toBe(true);
  expect(onDaemon(app, "thread-docs-index")).toBe(false);
  expect(onDaemon(app, "thread-readme")).toBe(false);

  // A fresh window on the same daemon: the list arrives without them.
  cleanup();
  await app.open("/");
  await within(await screen.findByRole("navigation", { name: "Threads" })).findAllByRole("link");
  expect(gone(/^Tidy the README/) && gone(/^Sketch the docs index/)).toBe(true);
  expect(listed(app, "thread-docs-index")).toBeUndefined();
  expect(listed(app, "thread-readme")).toBeUndefined();
}, 20_000);

test("a bulk delete removes the idle thread and offers Stop and delete for the running one", async () => {
  const app = await openWithIdle();
  await pick(/^Tidy the README/, "{Meta>}");
  await pick(/^Dedupe thread events/, "{Meta>}");
  await userEvent.click(within(bar()).getByRole("button", { name: "Delete 2 threads…" }));
  const dialog = await screen.findByRole("dialog", { name: "Delete 2 threads?" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Delete 2 threads" }));
  const running = await screen.findByRole("dialog", { name: "Delete thread?" });
  expect(running.textContent).toMatch(/running/);
  expect(onDaemon(app, "thread-readme")).toBe(false);
  expect(within(threads()).getByText(/^Dedupe thread events/)).toBeTruthy();
  expect(onDaemon(app, "thread-dedupe")).toBe(true);
  await userEvent.click(within(running).getByRole("button", { name: "Stop and delete" }));
  await waitFor(() => expect(gone(/^Dedupe thread events/)).toBe(true));
  await waitFor(() => expect(onDaemon(app, "thread-dedupe")).toBe(false));
}, 15_000);
