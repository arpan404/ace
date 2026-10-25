import { createIdleTask } from "@/test/tasks.ts";
import { workbench } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";

import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });
beforeEach(() => localStorage.clear());

async function openApp(path = "/") {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open(path);
  await within(await screen.findByRole("navigation", { name: "Threads" })).findAllByRole("link");
  return app;
}
const palette = async () => {
  await userEvent.keyboard("{Meta>}k{/Meta}");
  return screen.findByRole("combobox", { name: "Search commands" }, { timeout: 10000 });
};
const options = () => screen.getAllByRole("option").map((option) => option.textContent ?? "");

test("⌘K finds a thread by its branch and opens it", async () => {
  await openApp();
  const search = await palette();
  await userEvent.type(search, "perf/fan");
  // The thread first; the way into full-text search last.
  await waitFor(() => {
    expect(options()[0]).toBe("Backpressure on broadcast fan-outrelay · perf/fanoutThreads");
    expect(options().at(-1)).toBe("Search all threads for “perf/fan”");
  });
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("heading", { level: 1, name: "Backpressure on broadcast fan-out" });
  expect(screen.queryByRole("combobox", { name: "Search commands" })).toBeNull();
});

test("moving the highlight to a thread follows it before it is opened", async () => {
  // Threads that need the person are kept live anyway, so this uses two that don't.
  const app = await openApp();
  const search = await palette();
  await userEvent.type(search, "ro");
  await waitFor(() => {
    expect(options()[0]).toContain("Approval sheet loses its state on rotate");
    expect(options()[1]).toContain("Backpressure on broadcast fan-out");
  });
  await waitFor(() =>
    expect(app.client.cachedThread?.("thread-sheet-rotate")?.thread?.title).toBe(
      "Approval sheet loses its state on rotate",
    ),
  );
  expect(app.client.cachedThread?.("thread-fan-out")?.thread).toBeUndefined();
  await userEvent.keyboard("{ArrowDown}");
  await waitFor(() =>
    expect(app.client.cachedThread?.("thread-fan-out")?.thread?.title).toBe(
      "Backpressure on broadcast fan-out",
    ),
  );
});

test("typing finds threads that are absent from the empty palette", async () => {
  await openApp();
  const search = await palette();
  expect(screen.queryByRole("group", { name: "Threads" })).toBeNull();
  await userEvent.type(search, "replay");
  const match = await screen.findByRole("option", { name: /Dedupe thread events after reconnect/ });
  await userEvent.click(match);
  expect(
    await screen.findByRole("heading", { name: "Dedupe thread events after reconnect", level: 1 }),
  ).toBeTruthy();
});

test("choosing a project opens its latest thread", async () => {
  await openApp("/");
  const search = await palette();
  await userEvent.type(search, "billing");
  // The project itself, and a new thread in it.
  expect(await screen.findByRole("option", { name: /^New thread in billing-api/ })).toBeTruthy();
  await userEvent.click(await screen.findByRole("option", { name: /^billing-api.*Projects$/ }));
  expect(
    await screen.findByRole("heading", { level: 1, name: /Partial refunds|Invoice PDF/ }),
  ).toBeTruthy();
  // The list isn't narrowed to the project.
  expect(screen.queryByRole("button", { name: "Project filter: billing-api" })).toBeNull();
});

/** The words of a sheet's key-hint bar (decoration, hidden from assistive tech). */
const hints = (sheet: HTMLElement) =>
  sheet.querySelector('[data-slot="key-hints"]')?.textContent ?? "";

test("the palette's key hints name its keys, with Back only inside a step", async () => {
  await openApp();
  await palette();
  const sheet = screen.getByRole("dialog", { name: "Command palette" });
  for (const label of ["Navigate", "Select", "Close"]) expect(hints(sheet)).toContain(label);
  expect(hints(sheet)).not.toContain("Back");

  await userEvent.keyboard("new thread in");
  await userEvent.click(await screen.findByRole("option", { name: /^New thread in…/ }));
  const step = await screen.findByRole("dialog", { name: "New thread in" });
  for (const label of ["Navigate", "Select", "Back", "Close"]) expect(hints(step)).toContain(label);
  // With words in the field, Esc clears them before it closes.
  await userEvent.keyboard("billing");
  expect(hints(step)).toContain("Clear");
  expect(hints(step)).not.toContain("Close");
});

test("New thread in… lists the projects and opens a draft in the one chosen", async () => {
  await openApp();
  const search = await palette();
  await userEvent.type(search, "new thread in");
  await userEvent.click(await screen.findByRole("option", { name: /^New thread in…/ }));
  const step = await screen.findByRole("dialog", { name: "New thread in" });
  await userEvent.type(within(step).getByRole("combobox", { name: "Search projects" }), "billing");
  await userEvent.keyboard("{Enter}");
  expect(await screen.findByRole("button", { name: "Project: billing-api" })).toBeTruthy();
});

test("with several projects ⌘N asks which, and ⇧⌘N starts in the open thread's project", async () => {
  await openApp("/t/thread-fan-out");
  await screen.findByRole("heading", { level: 1, name: "Backpressure on broadcast fan-out" });
  await userEvent.keyboard("{Control>}n{/Control}");
  expect(await screen.findByRole("dialog", { name: "New thread in" })).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "New thread in" })).toBeNull());
  await userEvent.keyboard("{Control>}{Shift>}n{/Shift}{/Control}");
  expect(await screen.findByRole("button", { name: "Project: relay" })).toBeTruthy();
});

test("a leading > lists actions only", async () => {
  await openApp();
  const search = await palette();
  await userEvent.type(search, "backpressure");
  await screen.findByRole("option", { name: /^Backpressure on broadcast fan-out/ });
  await userEvent.clear(search);
  await userEvent.type(search, ">dark");
  await screen.findByRole("option", { name: /^Dark mode/ });
  await userEvent.clear(search);
  await userEvent.type(search, ">backpressure");
  await waitFor(() =>
    expect(screen.queryByRole("option", { name: /Backpressure on broadcast fan-out/ })).toBeNull(),
  );
  expect(screen.queryByRole("option", { name: /^Search all threads/ })).toBeNull();
});

test("on a settled thread, the palette brings it back to the list", async () => {
  const app = await openApp("/t/thread-bump-codex");
  await screen.findByRole("heading", { level: 1, name: "Bump Codex app-server to 0.48" });
  const search = await palette();
  await userEvent.type(search, "Unsettle");
  await userEvent.click(await screen.findByRole("option", { name: /^Unsettle/ }));
  expect(await screen.findByRole("link", { name: /^Bump Codex app-server to 0.48/ })).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("button", { name: /^Settled / })).toBeNull());
  const view = app.daemon.snapshot({ kind: "threads" });
  expect(view?.kind === "threads" && view.threads["thread-bump-codex"]?.settledAt).toBeFalsy();
});

test("the palette offers no Settle for a thread that is still working", async () => {
  await openApp("/t/thread-fan-out");
  await screen.findByRole("heading", { level: 1, name: "Backpressure on broadcast fan-out" });
  const search = await palette();
  await userEvent.type(search, "settle this");
  expect(screen.queryByRole("option", { name: /Settle this thread/ })).toBeNull();
});

test("with a query, an exact name beats one that only starts with it", async () => {
  await openApp();
  const search = await palette();
  await userEvent.type(search, "new thr");
  await waitFor(() => expect(options()[0]).toMatch(/^New thread/));
  await userEvent.clear(search);
  await userEvent.type(search, "settings");
  await waitFor(() => expect(options()[0]).toMatch(/^SettingsGo to/));
});

test("a query nothing matches falls through to searching every thread", async () => {
  await openApp();
  const search = await palette();
  await userEvent.type(search, "qqqzzz");
  await waitFor(() => expect(options()).toEqual(["Search all threads for “qqqzzz”"]));
  await userEvent.keyboard("{Enter}");
  // The search dialog takes the palette's place, with the words typed so far.
  const dialog = await screen.findByRole("dialog", { name: "Search" });
  expect(
    within(dialog).getByRole<HTMLInputElement>("combobox", { name: "Search every thread" }).value,
  ).toBe("qqqzzz");
  await waitFor(() =>
    expect(screen.queryByRole("combobox", { name: "Search commands" })).toBeNull(),
  );
});

test("an empty palette shows Actions, then recent threads with the last opened first", async () => {
  await openApp("/t/thread-fan-out");
  await screen.findByRole("heading", { level: 1, name: "Backpressure on broadcast fan-out" });
  const threads = within(screen.getByRole("navigation", { name: "Threads" }));
  await userEvent.click(threads.getByRole("link", { name: /^Partial refunds double-count tax/ }));
  await screen.findByRole("heading", { level: 1, name: /^Partial refunds double-count tax/ });
  const listed = threads.getAllByRole("link").length;
  await palette();
  const recent = within(await screen.findByRole("group", { name: "Recent threads" }));
  const rows = recent.getAllByRole("option").map((option) => option.textContent ?? "");
  expect(rows[0]).toMatch(/^Backpressure on broadcast fan-out/);
  // The open thread is not one of them; the rest fill up from the list, twelve at most.
  expect(rows.some((row) => row.startsWith("Partial refunds double-count tax"))).toBe(false);
  expect(rows.length).toBeLessThanOrEqual(12);
  expect(rows.length).toBeGreaterThanOrEqual(Math.min(listed - 1, 12));
  const actions = screen.getByRole("group", { name: "Actions" });
  const after = actions.compareDocumentPosition(
    screen.getByRole("group", { name: "Recent threads" }),
  );
  expect(after & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("a command run from the palette comes first among actions next time", async () => {
  await openApp();
  const search = await palette();
  await userEvent.type(search, "dark mode");
  await userEvent.click(await screen.findByRole("option", { name: /^Dark mode/ }));
  await waitFor(() => expect(document.documentElement.getAttribute("data-scheme")).toBe("dark"));
  await palette();
  const actions = within(await screen.findByRole("group", { name: "Actions" }));
  expect(actions.getAllByRole("option")[0]?.textContent).toMatch(/^Dark mode/);
});

test("threads and projects read by the project's name, never its id", async () => {
  const app = harness();
  const id = "a003e031-2390-44d2-b0a7-4a5fd727d463";
  createIdleTask(app.daemon, {
    id: "thread-scratch",
    workspaceId: id,
    title: "QA Codex lifecycle",
    provider: "codex",
    details: { workspace: { id, name: "scratch", path: "/fake/scratch" } },
  });
  await app.open("/t/thread-scratch");
  await screen.findByRole("heading", { level: 1, name: "QA Codex lifecycle" });
  const search = await palette();
  await userEvent.type(search, "scratch");
  await waitFor(() =>
    expect(options()).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^QA Codex lifecyclescratch/),
        expect.stringMatching(/^scratchProjects$/),
      ]),
    ),
  );
  expect(options().some((option) => option.includes(id))).toBe(false);
});
