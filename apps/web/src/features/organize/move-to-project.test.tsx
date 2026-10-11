import { createIdleTask } from "@/test/tasks.ts";
import { workbench } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";

import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

beforeEach(() => localStorage.clear());

const threads = () => screen.getByRole("navigation", { name: "Threads" });
const card = (title: RegExp) => within(threads()).queryByRole("link", { name: title });

async function openApp(path = "/", seed?: (app: ReturnType<typeof harness>) => void) {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  seed?.(app);
  await app.open(path);
  await within(await screen.findByRole("navigation", { name: "Threads" })).findAllByRole("link");
  return app;
}
type App = Awaited<ReturnType<typeof openApp>>;

/** The thread as the daemon's list has it. */
function listed(app: App, id: string) {
  const view = app.daemon.snapshot({ kind: "threads" });
  return view?.kind === "threads" ? view.threads[id] : undefined;
}

async function rowMenu(title: RegExp) {
  const target = card(title);
  if (!target) throw new Error(`No card for ${title}`);
  await userEvent.pointer({ keys: "[MouseRight]", target });
  return screen.findByRole("menu", { name: /^Actions for/ });
}

/** Open the row's picker, with focus in its search. */
async function openPicker(title: RegExp) {
  const menu = await rowMenu(title);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Move to project…" }));
  const search = await screen.findByRole("combobox", { name: "Search projects" });
  await waitFor(() => expect(document.activeElement).toBe(search));
}

/** Pick a project in the open picker by typing part of its name and pressing Enter. */
async function pickProject(typed: string) {
  const search = await screen.findByRole("combobox", { name: "Search projects" });
  await waitFor(() => expect(document.activeElement).toBe(search));
  await userEvent.type(search, typed);
  await userEvent.keyboard("{Enter}");
}

test("Move to project from a row's menu moves it at once and the daemon keeps it there", async () => {
  const app = await openApp();
  const menu = await rowMenu(/Invoice PDF/);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Move to project…" }));

  // The other projects are offered by name, without the one it is in.
  const picker = await screen.findByRole("dialog", { name: "Move to project" });
  const offered = await within(picker).findAllByRole("option");
  expect(offered.map((option) => option.getAttribute("aria-label"))).toEqual(
    expect.arrayContaining([expect.stringMatching(/^relay/), expect.stringMatching(/^docs-site/)]),
  );
  expect(offered.some((option) => option.getAttribute("aria-label") === "billing-api")).toBe(false);

  await pickProject("rel");
  expect(card(/^Invoice PDF locale fallback.*Project relay/)).toBeTruthy();
  expect(await screen.findByText("Moved to relay")).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: "Move to project" })).toBeNull();
  await waitFor(() => expect(listed(app, "thread-pdf-locale")?.workspaceId).toBe("relay"));
  expect(card(/^Invoice PDF locale fallback.*Project relay/)).toBeTruthy();
});

test("the picker is keyboard driven: arrows choose a project, Escape leaves it where it was", async () => {
  const app = await openApp();
  await openPicker(/Invoice PDF/);
  await userEvent.keyboard("{ArrowDown}");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Move to project" })).toBeNull());
  expect(listed(app, "thread-pdf-locale")?.workspaceId).toBe("billing-api");

  await openPicker(/Invoice PDF/);
  await userEvent.keyboard("{ArrowDown}");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(listed(app, "thread-pdf-locale")?.workspaceId).toBe("ace-mobile"));
});

test("Undo on the toast moves the thread back to its project", async () => {
  const app = await openApp();
  await openPicker(/Invoice PDF/);
  await pickProject("docs");
  await waitFor(() => expect(listed(app, "thread-pdf-locale")?.workspaceId).toBe("docs-site"));

  const toast = (await screen.findByText("Moved to docs-site")).closest("[role]");
  if (!(toast instanceof HTMLElement)) throw new Error("No toast");
  await userEvent.click(within(toast).getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(listed(app, "thread-pdf-locale")?.workspaceId).toBe("billing-api"));
  expect(card(/^Invoice PDF locale fallback.*Project billing-api/)).toBeTruthy();
});

test("a move the daemon refuses puts the row back, with the daemon's reason", async () => {
  const app = await openApp();
  // Its soak test still runs in the background, so the daemon won't move it yet.
  app.client.networkOnline(false);
  await openPicker(/Backpressure/);
  await pickProject("docs");
  // Shown in the new project at once, while the command waits for the connection.
  expect(card(/^Backpressure on broadcast fan-out.*Project docs-site/)).toBeTruthy();

  app.client.networkOnline(true);
  expect(await screen.findByText("Couldn't move the thread")).toBeTruthy();
  expect(screen.getByText("Stop its agents and close its terminals first.")).toBeTruthy();
  await waitFor(() =>
    expect(card(/^Backpressure on broadcast fan-out.*Project relay/)).toBeTruthy(),
  );
  expect(listed(app, "thread-fan-out")?.workspaceId).toBe("relay");
  await waitFor(() => expect(screen.queryByText("Moved to docs-site")).toBeNull());
});

test("a thread in its own worktree is refused with what to do instead", async () => {
  const app = await openApp("/", ({ daemon }) =>
    createIdleTask(daemon, {
      id: "thread-isolated",
      workspaceId: "relay",
      title: "Isolated experiment",
      provider: "codex",
      details: { mode: "worktree", worktree: "/fake/relay-isolated" },
    }),
  );
  await openPicker(/Isolated experiment/);
  await pickProject("docs");
  expect(
    await screen.findByText("It works in its own worktree. Switch it to the local checkout first."),
  ).toBeTruthy();
  await waitFor(() => expect(card(/^Isolated experiment.*Project relay/)).toBeTruthy());
  expect(listed(app, "thread-isolated")?.workspaceId).toBe("relay");
});

test("a pinned thread stays pinned, in its place, when it moves", async () => {
  const app = await openApp();
  await userEvent.click(
    within(await rowMenu(/Invoice PDF/)).getByRole("menuitem", { name: /^Pin/ }),
  );
  await waitFor(() => expect(listed(app, "thread-pdf-locale")?.pinned).toBe(true));
  const order = listed(app, "thread-pdf-locale")?.pinOrder;

  await openPicker(/Invoice PDF/);
  await pickProject("relay");
  expect(card(/^Invoice PDF locale fallback.*Project relay.*Pinned/)).toBeTruthy();
  await waitFor(() =>
    expect(listed(app, "thread-pdf-locale")).toMatchObject({
      workspaceId: "relay",
      pinned: true,
      pinOrder: order,
    }),
  );
  expect(card(/^Invoice PDF locale fallback.*Project relay.*Pinned/)).toBeTruthy();
});

test("the open thread's ⋯ menu moves it, and its project filter follows", async () => {
  const app = await openApp("/t/thread-bump-codex");
  await screen.findByRole("heading", { level: 1, name: "Bump Codex app-server to 0.48" });
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Move to project…" }));
  await pickProject("billing");
  await waitFor(() => expect(listed(app, "thread-bump-codex")?.workspaceId).toBe("billing-api"));
  expect(await screen.findByText("Moved to billing-api")).toBeTruthy();
  // The thread stays open where it was.
  expect(
    screen.getByRole("heading", { level: 1, name: "Bump Codex app-server to 0.48" }),
  ).toBeTruthy();
});

test("⌘K moves the open thread to another project", async () => {
  const app = await openApp("/t/thread-pdf-locale");
  await screen.findByRole("heading", { level: 1, name: "Invoice PDF locale fallback" });
  await userEvent.keyboard("{Meta>}k{/Meta}");
  const search = await screen.findByRole("combobox", { name: "Search commands" });
  await userEvent.type(search, "Move to project");
  await userEvent.click(await screen.findByRole("option", { name: /^Move to project/ }));
  await pickProject("ace-mobile");
  await waitFor(() => expect(listed(app, "thread-pdf-locale")?.workspaceId).toBe("ace-mobile"));
  expect(await screen.findByText("Moved to ace-mobile")).toBeTruthy();
});

test("picked threads move together from the selection bar, with one Undo", async () => {
  // A completed task, beside a failed one from another project.
  const app = await openApp("/", ({ daemon }) =>
    createIdleTask(daemon, {
      id: "thread-readme",
      workspaceId: "ace",
      title: "Tidy the README",
      provider: "codex",
    }),
  );
  const user = userEvent.setup();
  for (const title of [/Invoice PDF/, /Tidy the README/]) {
    await user.keyboard("{Meta>}");
    const target = card(title);
    if (!target) throw new Error(`No card for ${title}`);
    await user.click(target);
    await user.keyboard("{/Meta}");
  }
  const bar = await screen.findByRole("toolbar", { name: "Selected threads" });
  await user.click(within(bar).getByRole("button", { name: "Move 2 threads to project…" }));
  await pickProject("docs");
  expect(await screen.findByText("Moved 2 threads to docs-site")).toBeTruthy();
  await waitFor(() => {
    expect(listed(app, "thread-pdf-locale")?.workspaceId).toBe("docs-site");
    expect(listed(app, "thread-readme")?.workspaceId).toBe("docs-site");
  });
  expect(screen.queryByRole("toolbar", { name: "Selected threads" })).toBeNull();

  const toast = screen.getByText("Moved 2 threads to docs-site").closest("[role]");
  if (!(toast instanceof HTMLElement)) throw new Error("No toast");
  await user.click(within(toast).getByRole("button", { name: "Undo" }));
  await waitFor(() => {
    expect(listed(app, "thread-pdf-locale")?.workspaceId).toBe("billing-api");
    expect(listed(app, "thread-readme")?.workspaceId).toBe("ace");
  });
});
