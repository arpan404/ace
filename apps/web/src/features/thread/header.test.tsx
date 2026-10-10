import { facts, flakyCheckout, replayCursor, teamAtLimit, type Scenario } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ThreadId } from "@ace/protocol";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());
afterEach(() => Reflect.deleteProperty(globalThis, "ace"));

/** The commit form's primary button (its name also carries the ⌘↵ hint). */
const commitButton = /^Commit(?! &)/;

async function openThread(which: "replay" | "checkout" = "replay", through = "finding") {
  const app = harness();
  if (which === "replay") app.play(replayCursor()).runThrough(through);
  else app.play(flakyCheckout()).runThrough("explorer-spawned");
  await app.open(which === "replay" ? "/t/thread-replay-cursor" : "/t/thread-checkout");
  await screen.findByRole("feed", { name: "Transcript" });
  return app;
}

const header = () => {
  const found = document.querySelector("header");
  if (!found) throw new Error("No header");
  return found;
};
async function openEditorsMenu() {
  await userEvent.click(within(header()).getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Open in…" }));
}

const sidePanel = () => screen.findByRole("region", { name: "Thread panel" });

/** Open the work card from the header's list button. */
async function openCard() {
  await userEvent.click(within(header()).getByRole("button", { name: "Work card" }));
  return screen.findByRole("complementary", { name: "Work card" });
}

/** The git step the card's branch row offers once the checkout has been read. */
async function gitStep(name: string) {
  const card = await openCard();
  return within(card).findByRole("button", { name });
}

/** A git action from the card's branch row ⋯. */
async function gitMenu(item: RegExp) {
  const card = await openCard();
  await userEvent.click(await within(card).findByRole("button", { name: "Git actions" }));
  return screen.findByRole("menuitem", { name: item });
}

/** A one-thread scenario with this checkout, and only the root agent (the thread is idle). */
function idleThread(id: string, details: NonNullable<Scenario["thread"]["details"]>): Scenario {
  return {
    thread: { id, workspaceId: "scratch", title: "Sketch a parser", provider: "claude", details },
    steps: [{ kind: "facts", facts: [facts.rootAgent("claude")] }],
  };
}

const sketch = {
  workspace: { id: "scratch", name: "scratch", path: "/Users/dev/scratch" },
  mode: "local" as const,
  worktree: "/Users/dev/scratch",
  branch: "sketch/parser",
  head: "a".repeat(40),
  ahead: 0,
  behind: 0,
  baseBranch: "main",
  machine: { host: "fake-host", name: "This Mac" },
};

// ---------------------------------------------------------------------------------------------
// The header

test("the header keeps only navigation, the title, its ⋯, the work card and the side panel's toggle", async () => {
  await openThread();
  const names = within(header())
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label"));
  expect(names).toEqual([
    expect.stringMatching(/sidebar$/),
    "Back",
    "Forward",
    "More actions",
    "Work card",
    "Right panel",
  ]);
  expect(within(header()).getByRole("heading", { level: 1 }).textContent).toBe(
    "Replay cursor resets on every resume",
  );
  expect(within(header()).queryByRole("status")).toBeNull();
});

test("a usage limit remains on the sidebar and leaves the thread title clear", async () => {
  const app = harness();
  for (const scenario of teamAtLimit()) app.play(scenario).runThrough("limited");
  await app.open("/t/thread-limit-flags");
  await screen.findByRole("feed", { name: "Transcript" });
  const list = await screen.findByRole("navigation", { name: "Threads" });
  const row = await within(list).findByRole("link", {
    name: /Remove the legacy feature-flag reader/,
  });
  expect(row.getAttribute("aria-label")).toContain("Limited");
  expect(within(header()).queryByRole("status")).toBeNull();
});

test("search and turns live in the ⋯ menu, and their shortcuts still work", async () => {
  await openThread();
  await userEvent.click(within(header()).getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /^Search this thread/ }));
  expect(await screen.findByRole("search", { name: "Search this thread" })).toBeTruthy();
  await userEvent.keyboard("{Escape}");

  await userEvent.keyboard("{Alt>}{Meta>}g{/Meta}{/Alt}");
  expect(await screen.findByRole("complementary", { name: "Turns" })).toBeTruthy();
});

// ---------------------------------------------------------------------------------------------
// The work card

test("the work card opens under its button and closes on Escape, giving focus back, or on a click outside", async () => {
  await openThread();
  const button = within(header()).getByRole("button", { name: "Work card" });
  const card = await openCard();
  expect(button.getAttribute("aria-pressed")).toBe("true");
  expect(within(card).getByRole("heading", { level: 2 }).textContent).toBe("relay");

  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("complementary", { name: "Work card" })).toBeNull(),
  );
  expect(document.activeElement).toBe(button);
  expect(button.getAttribute("aria-pressed")).toBe("false");

  await openCard();
  await userEvent.click(screen.getByRole("feed", { name: "Transcript" }));
  expect(screen.getByRole("complementary", { name: "Work card" })).toBeTruthy();
  await userEvent.click(button);

  // ⌥⌘O toggles it from anywhere on the thread.
  await act(() => userEvent.keyboard("{Alt>}{Meta>}o{/Meta}{/Alt}"));
  expect(await screen.findByRole("complementary", { name: "Work card" })).toBeTruthy();
  await act(() => userEvent.keyboard("{Alt>}{Meta>}o{/Meta}{/Alt}"));
  await waitFor(() =>
    expect(screen.queryByRole("complementary", { name: "Work card" })).toBeNull(),
  );
});

test("a menu opened from the card closes before the card does", async () => {
  await openThread();
  const card = await openCard();
  await userEvent.click(within(card).getByRole("button", { name: "Project actions" }));
  expect(await screen.findByRole("menuitem", { name: /^Copy path/ })).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menuitem", { name: /^Copy path/ })).toBeNull());
  expect(screen.getByRole("complementary", { name: "Work card" })).toBeTruthy();
});

test("Changes in the card opens the Changes tab and gets out of the way", async () => {
  await openThread();
  const card = await openCard();
  await userEvent.click(within(card).getByRole("button", { name: /^Changes,/ }));
  const panel = await sidePanel();
  expect(within(panel).getByRole("tab", { name: /^Changes/, selected: true })).toBeTruthy();
  await waitFor(() =>
    expect(screen.queryByRole("complementary", { name: "Work card" })).toBeNull(),
  );
});

test("an action from the card runs the project's script in a terminal tab of the side panel", async () => {
  // Before the agent starts the relay in the background.
  const app = await openThread("replay", "delegated");
  const card = await openCard();
  const actions = within(card).getByRole("region", { name: "Actions" });
  await userEvent.click(
    await within(actions).findByRole("button", { name: "Run bun run dev:relay" }),
  );
  const panel = await sidePanel();
  // The tab opening on the script's terminal is the only confirmation.
  expect(await within(panel).findByRole("tab", { name: "dev:relay", selected: true })).toBeTruthy();
  await waitFor(() =>
    expect(within(panel).getByRole("log", { name: "dev:relay output" }).textContent).toContain(
      "relay listening on ws://127.0.0.1:8787",
    ),
  );
  expect(screen.queryByRole("region", { name: "Bottom panel" })).toBeNull();
  expect(app.daemon.terminals.list("thread-replay-cursor").map((t) => t.name)).toEqual([
    "dev:relay",
  ]);

  // Running it again goes back to its terminal rather than starting a second one, and the
  // card says it is running.
  await userEvent.click(within(panel).getByRole("tab", { name: /^Changes/ }));
  const again = within(await openCard()).getByRole("region", { name: "Actions" });
  await userEvent.click(
    await within(again).findByRole("button", {
      name: "Run bun run dev:relay, running: shows its terminal",
    }),
  );
  expect(await within(panel).findByRole("tab", { name: "dev:relay", selected: true })).toBeTruthy();
  expect(app.daemon.terminals.list("thread-replay-cursor")).toHaveLength(1);
});

test("the actions search narrows the scripts by name or command", async () => {
  const app = harness();
  app.daemon.setScripts("relay", ["dev:relay", "soak", "test", "lint", "typecheck"]);
  app.play(replayCursor()).runThrough("finding");
  await app.open("/t/thread-replay-cursor");
  await screen.findByRole("feed", { name: "Transcript" });
  const card = await openCard();
  const actions = within(card).getByRole("region", { name: "Actions" });
  const list = await within(actions).findByRole("list", { name: "Project actions" });
  expect(within(list).getAllByRole("button")).toHaveLength(5);

  await userEvent.type(within(actions).getByRole("searchbox", { name: "Search actions" }), "so");
  await waitFor(() =>
    expect(
      within(list)
        .getAllByRole("button")
        .map((row) => row.getAttribute("aria-label")),
    ).toEqual(["Run bun run soak"]),
  );
  await userEvent.clear(within(actions).getByRole("searchbox", { name: "Search actions" }));
  await userEvent.type(within(actions).getByRole("searchbox", { name: "Search actions" }), "zzz");
  expect(await within(actions).findByText("No action matches “zzz”")).toBeTruthy();
});

test("an action an agent already runs in the background shows the agent's shell, not a second copy", async () => {
  const app = await openThread();
  const card = await openCard();
  await userEvent.click(
    await within(card).findByRole("button", {
      name: "Run bun run dev:relay, running: shows its terminal",
    }),
  );
  const panel = await sidePanel();
  expect(await within(panel).findByRole("tab", { name: "dev:relay", selected: true })).toBeTruthy();
  expect(await within(panel).findByText("Agent shell")).toBeTruthy();
  expect(app.daemon.terminals.list("thread-replay-cursor")).toEqual([]);
});

test("a project without scripts says how to add one, and Add action says the same", async () => {
  const app = harness();
  app.daemon.setScripts("relay", []);
  app.play(replayCursor()).runThrough("finding");
  await app.open("/t/thread-replay-cursor");
  await screen.findByRole("feed", { name: "Transcript" });
  const actions = within(await openCard()).getByRole("region", { name: "Actions" });
  const hint = "Add a script to package.json, a Makefile, justfile or Procfile";
  expect(await within(actions).findByText(hint)).toBeTruthy();
  const add = within(actions).getByRole("button", { name: "Add action" });
  expect(add.getAttribute("aria-disabled")).toBe("true");
});

test("when the scripts can't be read, the card says so and reads them again", async () => {
  const app = harness();
  app.daemon.failRequests("workspace.request");
  app.play(replayCursor()).runThrough("finding");
  await app.open("/t/thread-replay-cursor");
  await screen.findByRole("feed", { name: "Transcript" });
  const actions = within(await openCard()).getByRole("region", { name: "Actions" });
  const retry = await within(actions).findByRole("button", {
    name: /Couldn't read this project's scripts/,
  });
  app.daemon.restoreRequests();
  await userEvent.click(retry);
  expect(
    await within(actions).findByRole("button", { name: /^Run bun run dev:relay/ }),
  ).toBeTruthy();
});

test("Open in launches the checkout in an editor, and the one picked becomes the default", async () => {
  await openThread();
  const launched = vi.spyOn(window, "open").mockImplementation(() => null);
  const card = await openCard();
  expect(within(card).queryByRole("region", { name: "Open in" })).toBeNull();
  await userEvent.keyboard("{Escape}");
  const openEditors = async () => {
    await userEvent.click(within(header()).getByRole("button", { name: "More actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Open in…" }));
    return screen.findByRole("menuitem", { name: "Open in Visual Studio Code, default" });
  };
  expect(await openEditors()).toBeTruthy();
  await userEvent.click(await screen.findByRole("menuitem", { name: "Open in Zed" }));
  expect(await screen.findByText("Opened in Zed")).toBeTruthy();
  expect(launched).toHaveBeenCalledWith("zed://file/Users/dev/relay", "_self");
  await userEvent.click(within(header()).getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Open in…" }));
  const picked = await screen.findByRole("menuitem", { name: "Open in Zed, default" });
  const menu = picked.closest('[role="menu"]');
  expect(menu).toBeTruthy();
  expect(menu?.querySelector('[role="menuitem"]')?.textContent).toContain("Zed");
  launched.mockRestore();
});

test("the header only offers installed editors and says when none are installed", async () => {
  const app = await openThread();
  app.daemon.workspace.setEditors([]);
  await userEvent.click(within(header()).getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Open in…" }));
  expect(await screen.findByRole("menuitem", { name: "No editors installed" })).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: /Open in (Visual Studio Code|Zed)/ })).toBeNull();
  await userEvent.keyboard("{Escape}{Escape}");
  app.daemon.workspace.setEditors([{ id: "cursor", name: "Cursor", command: "cursor" }]);
  await userEvent.click(within(header()).getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Open in…" }));
  const editor = await screen.findByRole("menuitem", { name: "Open in Cursor, default" });
  expect(editor.querySelector('[data-app-icon="cursor"]')).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: /Open in (Visual Studio Code|Zed)/ })).toBeNull();
});

test("editor discovery refreshes after reconnect without keeping removed apps", async () => {
  const app = await openThread();
  await openEditorsMenu();
  expect(
    await screen.findByRole("menuitem", { name: "Open in Visual Studio Code, default" }),
  ).toBeTruthy();
  await userEvent.keyboard("{Escape}{Escape}");
  act(() => app.daemon.refuseConnections(true));
  await waitFor(() =>
    expect(document.querySelector("[data-connection]")?.getAttribute("data-connection")).not.toBe(
      "ready",
    ),
  );
  app.daemon.workspace.setEditors([{ id: "zed", name: "Zed", command: "zed" }]);
  act(() => app.daemon.refuseConnections(false));
  await waitFor(() =>
    expect(document.querySelector("[data-connection]")?.getAttribute("data-connection")).toBe(
      "ready",
    ),
  );
  await openEditorsMenu();
  expect(await screen.findByRole("menuitem", { name: "Open in Zed, default" })).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: /Open in Visual Studio Code/ })).toBeNull();
});

test("the branch keeps its complete status and one commit entry point", async () => {
  const branch = "feature/a-very-long-branch-name-that-needs-a-tooltip";
  const app = harness();
  app
    .play(
      idleThread("thread-branch", {
        ...sketch,
        branch,
        diff: { files: 3, additions: 38, deletions: 6 },
      }),
    )
    .runUntilBlocked();
  await app.open("/t/thread-branch");
  await screen.findByRole("feed", { name: "Transcript" });
  const card = await openCard();
  expect(await within(card).findByText("3 uncommitted")).toBeTruthy();
  await userEvent.hover(
    within(within(card).getByRole("region", { name: "Changes and branch" })).getByText(branch),
  );
  expect((await screen.findByRole("tooltip")).textContent).toBe(`${branch} · 3 uncommitted`);
  await userEvent.unhover(
    within(within(card).getByRole("region", { name: "Changes and branch" })).getByText(branch),
  );
  expect(within(card).getAllByRole("button", { name: /^Commit/ })).toHaveLength(1);
  await userEvent.click(within(card).getByRole("button", { name: "Git actions" }));
  await screen.findByRole("menu");
  expect(screen.queryByRole("menuitem", { name: /^Commit/ })).toBeNull();
});

test("a provider MCP server waiting for its own sign-in shows nowhere in the thread", async () => {
  const app = harness();
  app.daemon.mcp.servers.set("claude", [{ name: "vercel", status: "needs_auth" }]);
  app.play(idleThread("thread-mcp", sketch)).runUntilBlocked();
  await app.open("/t/thread-mcp");
  await screen.findByRole("feed", { name: "Transcript" });
  const card = await openCard();
  await within(within(card).getByRole("region", { name: "Changes and branch" })).findByText(
    "sketch/parser",
  );
  expect(within(card).queryByRole("region", { name: "Sources" })).toBeNull();
  // Nothing in the header, card, transcript, composer or sidebar names the server or its state.
  expect(screen.queryAllByText(/vercel|not signed in|MCP|connector/i)).toHaveLength(0);
  expect(screen.queryAllByRole("alert")).toHaveLength(0);
});

test("another thread opens with the card closed", async () => {
  const app = harness();
  app.play(flakyCheckout()).runThrough("explorer-spawned");
  app.play(replayCursor()).runThrough("finding");
  await app.open("/t/thread-replay-cursor");
  await screen.findByRole("feed", { name: "Transcript" });
  await openCard();
  const threads = screen.getByRole("navigation", { name: "Threads" });
  await userEvent.click(within(threads).getByRole("link", { name: /Fix flaky checkout test/ }));
  await screen.findByRole("heading", { level: 1, name: "Fix flaky checkout test" });
  expect(screen.queryByRole("complementary", { name: "Work card" })).toBeNull();
});

// ---------------------------------------------------------------------------------------------
// Git, from the card's branch row

test("the card's branch row walks the branch from Commit & push to Create PR, and the PR opens from Pull requests", async () => {
  const app = await openThread("checkout");
  const opened = vi.spyOn(window, "open").mockImplementation(() => null);
  await userEvent.click(await gitStep("Commit & push"));
  const commit = await screen.findByRole("dialog", { name: "Commit changes" });
  const message = within(commit).getByRole("textbox", { name: "Commit message" });
  expect((message as HTMLInputElement).value).toBe("Fix flaky checkout test");
  await userEvent.clear(message);
  await userEvent.type(message, "Wait for the payment intent before asserting");
  await within(commit).findByRole("list", { name: "Files to commit" });
  await userEvent.click(within(commit).getByRole("button", { name: /^Commit & push/ }));
  expect(await screen.findByText("Committed and pushed")).toBeTruthy();

  await userEvent.click(await gitStep("Create PR"));
  const pr = await screen.findByRole("dialog", { name: "Open a pull request" });
  await userEvent.click(within(pr).getByRole("button", { name: /^Create PR/ }));
  expect(await screen.findByText(/^Pull request #1 opened$/)).toBeTruthy();

  const prs = within(await openCard()).getByRole("region", { name: "Pull requests" });
  await userEvent.click(await within(prs).findByRole("button", { name: /^Pull request #1/ }));
  await screen.findByRole("region", { name: "Pull request #1" });
  await userEvent.click(within(prs).getByRole("button", { name: "Open on GitHub" }));
  expect(opened).toHaveBeenCalledWith(
    "https://github.com/acme/billing-api/pull/1",
    "_blank",
    "noopener,noreferrer",
  );
  const details = app.daemon.snapshot({
    kind: "thread",
    threadId: ThreadId.parse("thread-checkout"),
  });
  expect(details && "thread" in details && details.thread.details).toMatchObject({
    ahead: 0,
    diff: { files: 0 },
    linkedPr: { number: 1, state: "open" },
  });
  opened.mockRestore();
});

test("Commit lists exactly the files git reports, preselects new and tracked files, and commits only what is ticked", async () => {
  const app = await openThread("checkout");
  app.daemon.workspace.setGitStatus("thread-checkout", [
    { path: ".env.local", status: "untracked", additions: 2, deletions: 0, binary: false },
    { path: "src/checkout.ts", status: "modified", additions: 12, deletions: 4, binary: false },
    {
      path: "src/payments/wait.ts",
      from: "src/payments/poll.ts",
      status: "renamed",
      additions: 3,
      deletions: 1,
      binary: false,
    },
  ]);
  await userEvent.click(await gitStep("Commit & push"));
  const form = await screen.findByRole("dialog", { name: "Commit changes" });
  await userEvent.click(within(form).getByRole("checkbox", { name: "Push after committing" }));
  const dialog = await screen.findByRole("dialog", { name: "Commit changes" });
  const list = await within(dialog).findByRole("list", { name: "Files to commit" });
  const box = (path: string) => within(list).getByRole("checkbox", { name: path });
  // In git's order, one row per file.
  const rows = within(list).getAllByRole("checkbox");
  expect(
    rows.map((row) =>
      [".env.local", "src/checkout.ts", "src/payments/wait.ts"].map(box).indexOf(row),
    ),
  ).toEqual([0, 1, 2]);
  expect(box(".env.local").getAttribute("aria-checked")).toBe("true");
  expect(box("src/checkout.ts").getAttribute("aria-checked")).toBe("true");
  expect(box("src/payments/wait.ts").getAttribute("aria-checked")).toBe("true");
  expect(within(dialog).getByText("· 3 picked")).toBeTruthy();

  await userEvent.click(box("src/checkout.ts"));
  await userEvent.click(within(dialog).getByRole("button", { name: commitButton }));
  expect(await screen.findByText("Committed")).toBeTruthy();
  // The rename went in with its old path; the unticked files stayed uncommitted.
  expect(app.daemon.workspace.gitStatus("thread-checkout").map((file) => file.path)).toEqual([
    "src/checkout.ts",
  ]);
});

test("Commit can't run with nothing picked, and View diff shows the changes instead", async () => {
  const app = await openThread("checkout");
  app.daemon.workspace.setGitStatus("thread-checkout", [
    { path: "notes.md", status: "untracked", additions: 1, deletions: 0, binary: false },
  ]);
  await userEvent.click(await gitStep("Commit & push"));
  const form = await screen.findByRole("dialog", { name: "Commit changes" });
  await userEvent.click(within(form).getByRole("checkbox", { name: "Push after committing" }));
  const dialog = await screen.findByRole("dialog", { name: "Commit changes" });
  const files = await within(dialog).findByRole("list", { name: "Files to commit" });
  await userEvent.click(within(files).getByRole("checkbox", { name: "notes.md" }));
  expect(within(dialog).getByRole("button", { name: commitButton }).hasAttribute("disabled")).toBe(
    true,
  );

  await userEvent.click(within(dialog).getByRole("button", { name: "View diff" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Commit changes" })).toBeNull());
  const panel = await sidePanel();
  expect(within(panel).getByRole("tab", { name: /^Changes/, selected: true })).toBeTruthy();
});

test("Create PR says why it can't run when the checkout has no GitHub or GitLab remote", async () => {
  const app = harness();
  app.play(idleThread("thread-no-remote", sketch)).runUntilBlocked();
  await app.open("/t/thread-no-remote");
  await screen.findByRole("feed", { name: "Transcript" });
  const create = await gitStep("Create PR");
  await waitFor(() => expect(create.getAttribute("aria-disabled")).toBe("true"));
  expect(create.getAttribute("aria-description")).toBe(
    "ace found no GitHub or GitLab remote for this checkout.",
  );
  await userEvent.click(create);
  expect(screen.queryByRole("dialog", { name: "Open a pull request" })).toBeNull();
});

test("the card says when the thread's directory isn't a git checkout, and offers no git step", async () => {
  const plain: Scenario = {
    thread: {
      id: "thread-no-git",
      workspaceId: "scratch",
      title: "Notes",
      provider: "claude",
      details: { workspace: { id: "scratch", name: "scratch", path: "/Users/dev/notes" } },
    },
    steps: [{ kind: "facts", facts: [facts.rootAgent("claude")] }],
  };
  const app = harness();
  app.play(plain).runUntilBlocked();
  await app.open("/t/thread-no-git");
  await screen.findByRole("feed", { name: "Transcript" });
  const card = await openCard();
  expect(await within(card).findByText("Not a git checkout")).toBeTruthy();
  expect(within(card).queryByRole("button", { name: "Git actions" })).toBeNull();
  expect(within(card).getByText("No branch to open one from")).toBeTruthy();
});

test("with a linked PR, the card lists it, opens it, and says why a draft PR can't be created", async () => {
  const app = harness();
  app
    .play(
      idleThread("thread-linked-pr", {
        ...sketch,
        workspace: { id: "api", name: "api", path: "/Users/dev/api" },
        worktree: "/Users/dev/api",
        branch: "fix/restart-retry",
        diff: { files: 3, additions: 64, deletions: 12 },
        linkedPr: { number: 188, state: "open" },
        repository: { forge: "github", host: "github.com", owner: "acme", name: "api" },
      }),
    )
    .runUntilBlocked();
  await app.open("/t/thread-linked-pr");
  await screen.findByRole("feed", { name: "Transcript" });
  const opened = vi.spyOn(window, "open").mockImplementation(() => null);
  const draft = await gitMenu(/^Create draft PR/);
  expect(draft.getAttribute("aria-disabled")).toBe("true");
  expect(draft.textContent).toContain("PR #188 is already open");
  await userEvent.keyboard("{Escape}");

  const prs = within(screen.getByRole("complementary", { name: "Work card" })).getByRole("region", {
    name: "Pull requests",
  });
  await userEvent.click(within(prs).getByRole("button", { name: /^Pull request #188/ }));
  await screen.findByRole("region", { name: "Pull request #188" });
  await userEvent.click(within(prs).getByRole("button", { name: "Open on GitHub" }));
  expect(opened).toHaveBeenCalledWith(
    "https://github.com/acme/api/pull/188",
    "_blank",
    "noopener,noreferrer",
  );
  opened.mockRestore();
});

test("the commit dialog lists the checkout's uncommitted files and can push too, with ⌘↵", async () => {
  const app = await openThread("checkout");
  await userEvent.click(await gitStep("Commit & push"));
  const form = await screen.findByRole("dialog", { name: "Commit changes" });
  await userEvent.click(within(form).getByRole("checkbox", { name: "Push after committing" }));
  const commit = await screen.findByRole("dialog", { name: "Commit changes" });
  // The fake checkout reports 3 uncommitted files, all picked.
  expect(await within(commit).findByRole("button", { name: "3 files" })).toBeTruthy();
  expect(within(commit).getByText("· 3 picked")).toBeTruthy();
  await userEvent.click(within(commit).getByRole("checkbox", { name: "Push after committing" }));
  expect(within(commit).getByRole("button", { name: /^Commit & push/ })).toBeTruthy();
  await userEvent.click(within(commit).getByRole("textbox", { name: "Commit details" }));
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  expect(await screen.findByText("Committed and pushed")).toBeTruthy();
  const details = app.daemon.snapshot({
    kind: "thread",
    threadId: ThreadId.parse("thread-checkout"),
  });
  expect(details && "thread" in details && details.thread.details).toMatchObject({
    ahead: 0,
    diff: { files: 0 },
  });
});

test("the PR dialog's Draft option opens a draft pull request", async () => {
  await openThread("checkout");
  await userEvent.click(await gitStep("Commit & push"));
  const commit = await screen.findByRole("dialog", { name: "Commit changes" });
  await within(commit).findByRole("list", { name: "Files to commit" });
  await userEvent.click(within(commit).getByRole("button", { name: /^Commit & push/ }));
  await userEvent.click(await gitStep("Create PR"));
  const pr = await screen.findByRole("dialog", { name: "Open a pull request" });
  await userEvent.click(within(pr).getByRole("checkbox", { name: /Draft/ }));
  await userEvent.click(within(pr).getByRole("button", { name: /^Create draft PR/ }));
  expect(await screen.findByText(/^Draft pull request #\d+ opened$/)).toBeTruthy();
});

const renamed = (index: number) => ({
  path: `src/moved/${String(index).padStart(3, "0")}.ts`,
  from: `src/old/${String(index).padStart(3, "0")}.ts`,
  status: "renamed" as const,
  additions: 1,
  deletions: 1,
  binary: false,
});

test("a full page of renames commits in one go: each names both its paths", async () => {
  const app = await openThread("checkout");
  app.daemon.workspace.setGitStatus(
    "thread-checkout",
    Array.from({ length: 251 }, (_, index) => renamed(index)),
  );
  await userEvent.click(await gitStep("Commit & push"));
  const form = await screen.findByRole("dialog", { name: "Commit changes" });
  await userEvent.click(within(form).getByRole("checkbox", { name: "Push after committing" }));
  const dialog = await screen.findByRole("dialog", { name: "Commit changes" });
  expect(await within(dialog).findByText("· 251 picked")).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: commitButton }));
  expect(await screen.findByText("Committed")).toBeTruthy();
  expect(app.daemon.workspace.gitStatus("thread-checkout")).toEqual([]);
});

test("past 500 files the list says it is cut short, and commits only what it lists", async () => {
  const app = await openThread("checkout");
  app.daemon.workspace.setGitStatus(
    "thread-checkout",
    Array.from({ length: 501 }, (_, index) => ({
      path: `src/file-${String(index).padStart(3, "0")}.ts`,
      status: "modified" as const,
      additions: 1,
      deletions: 0,
      binary: false,
    })),
  );
  await userEvent.click(await gitStep("Commit & push"));
  const form = await screen.findByRole("dialog", { name: "Commit changes" });
  await userEvent.click(within(form).getByRole("checkbox", { name: "Push after committing" }));
  const dialog = await screen.findByRole("dialog", { name: "Commit changes" });
  expect(await within(dialog).findByRole("button", { name: "500+ files" })).toBeTruthy();
  expect(
    within(dialog).getByText("Only the first 500 files are listed; the rest stay uncommitted."),
  ).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: commitButton }));
  expect(await screen.findByText("Committed")).toBeTruthy();
  expect(app.daemon.workspace.gitStatus("thread-checkout").map((file) => file.path)).toEqual([
    "src/file-500.ts",
  ]);
});

// ---------------------------------------------------------------------------------------------
// Where the thread runs, at the head of the card

test("environment details move into the work card while project actions only change the checkout", async () => {
  await openThread("checkout");
  const card = await openCard();
  expect(within(card).queryByRole("button", { name: /^Where this thread runs/ })).toBeNull();
  await userEvent.click(within(card).getByRole("button", { name: "Project actions" }));
  const menu = await screen.findByRole("menu");
  expect(within(menu).queryByText("Machine")).toBeNull();
  expect(within(menu).queryByText("Environment")).toBeNull();
  const move = within(menu).getByRole("menuitem", { name: /Move to a worktree/ });
  expect(move.getAttribute("aria-disabled")).toBe("true");
  await userEvent.keyboard("{Escape}");
  const environment = await screen.findByRole("region", { name: "Checkout details" });
  expect(within(environment).getByText("Machine")).toBeTruthy();
  expect(within(environment).getByText("Fake machine")).toBeTruthy();
  expect(within(environment).getByText("Commit")).toBeTruthy();
});

test("from the card, an idle thread switches branch and moves into a worktree of its own", async () => {
  const app = harness();
  app.play(idleThread("thread-idle", sketch)).runUntilBlocked();
  await app.open("/t/thread-idle");
  await screen.findByRole("feed", { name: "Transcript" });
  const card = await openCard();
  await userEvent.click(within(card).getByRole("button", { name: "Project actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /Switch branch/ }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "develop" }));
  expect(await screen.findByText("Switched to develop")).toBeTruthy();
  expect(
    (
      await within(within(card).getByRole("region", { name: "Changes and branch" })).findByText(
        "develop",
      )
    ).textContent,
  ).toBe("develop");

  await userEvent.click(within(card).getByRole("button", { name: "Project actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /Move to a worktree/ }));
  expect(await screen.findByText("Moved to a worktree")).toBeTruthy();
  const environment = await screen.findByRole("region", { name: "Checkout details" });
  expect(within(environment).getByText("Its own worktree")).toBeTruthy();
});

// ---------------------------------------------------------------------------------------------
// The ⋯ menu's thread actions

test("renaming from the ⋯ menu changes the title", async () => {
  await openThread();
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /^Rename/ }));
  const field = await screen.findByRole("textbox", { name: "Thread title" });
  await userEvent.clear(field);
  await userEvent.type(field, "Cold-start replay cap{Enter}");
  expect(
    await screen.findByRole("heading", { level: 1, name: "Cold-start replay cap" }),
  ).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: "Rename thread" })).toBeNull();
  expect(screen.getByText("Renamed · Cold-start replay cap")).toBeTruthy();
});

test("archiving from the ⋯ menu leaves the thread", async () => {
  await openThread();
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /^Archive/ }));
  expect(await screen.findByText("Archived · Replay cursor resets on every resume")).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("feed", { name: "Transcript" })).toBeNull());
});

test("deleting a thread with work still running from the ⋯ menu keeps it and says why", async () => {
  const app = await openThread();
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Delete thread" }));
  expect(
    await screen.findByText(/^Still running: \d+ agents?\.$/, undefined, { timeout: 9_000 }),
  ).toBeTruthy();
  expect(screen.getByRole("feed", { name: "Transcript" })).toBeTruthy();
  const view = app.daemon.snapshot({ kind: "threads" });
  expect(view?.kind === "threads" && view.threads["thread-replay-cursor"]).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
});

test("the ⋯ menu keeps the common thread actions in the row menu's order", async () => {
  await openThread();
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  const items = (await screen.findAllByRole("menuitem")).map((item) => item.textContent ?? "");
  await userEvent.keyboard("{Escape}");
  const row = within(screen.getByRole("navigation", { name: "Threads" })).getByRole("link", {
    name: /Replay cursor resets/,
  });
  await userEvent.pointer({ keys: "[MouseRight]", target: row });
  const menu = await screen.findByRole("menu", { name: /^Actions for/ });
  const context = within(menu)
    .getAllByRole("menuitem")
    .map((item) => (item.textContent ?? "").replace(/(Shift\+N|R|P)$/, ""))
    .filter((label) => !/^(Link pull request…|Unlink all pull requests)$/.test(label));
  // The thread screen adds a side chat, the agent tree and the long-thread tools, and shows its
  // own shortcuts.
  const shortcut = /(Alt\+Ctrl\+[RP]|(Alt\+)?Shift\+Ctrl\+A|⌥⌘[RP]|⇧⌘A)$/;
  expect(
    items
      .filter(
        (label) =>
          !/^(Open agent tree|New side chat|Attachments|Open in…|Search this thread|Turns)/.test(
            label,
          ),
      )
      .map((label) => label.replace(shortcut, "")),
  ).toEqual(context);
  expect(context.slice(0, 4)).toEqual([
    "New thread on main",
    "Rename",
    expect.stringMatching(/^Fork from the last turn…/),
    "Copy link",
  ]);
});

test("the ⋯ menu shows the thread's shortcuts, and they rename, pin and archive it", async () => {
  const app = await openThread();
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  for (const [name, keys] of [
    ["Rename", /Alt\+Ctrl\+R|⌥⌘R/],
    ["Pin", /Alt\+Ctrl\+P|⌥⌘P/],
    ["Archive", /Shift\+Ctrl\+A|⇧⌘A/],
  ] as const)
    expect(
      (await screen.findByRole("menuitem", { name: new RegExp(`^${name}`) })).textContent,
    ).toMatch(keys);
  await userEvent.keyboard("{Escape}");

  await userEvent.keyboard("{Alt>}{Meta>}p{/Meta}{/Alt}");
  await waitFor(() => {
    const view = app.daemon.snapshot({ kind: "threads" });
    expect(view?.kind === "threads" && view.threads["thread-replay-cursor"]?.pinned).toBe(true);
  });

  await userEvent.keyboard("{Alt>}{Meta>}r{/Meta}{/Alt}");
  expect(await screen.findByRole("textbox", { name: "Thread title" })).toBeTruthy();
  await userEvent.keyboard("{Escape}");

  // Off Apple platforms Archive is Ctrl+Alt+Shift+A (Ctrl+Shift+A is Agents there).
  await userEvent.keyboard("{Control>}{Alt>}{Shift>}a{/Shift}{/Alt}{/Control}");
  expect(await screen.findByText("Archived · Replay cursor resets on every resume")).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("feed", { name: "Transcript" })).toBeNull());
});

test("the thread menu offers working thread actions without Side chat", async () => {
  await openThread();
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  expect(await screen.findByRole("menuitem", { name: /Open agent tree/ })).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: /side chat/i })).toBeNull();
});

test("Fork says why it is unavailable before the first turn has finished", async () => {
  const app = harness();
  app.play(replayCursor()).runThrough("finding");
  await app.open("/t/thread-replay-cursor");
  await screen.findByRole("feed", { name: "Transcript" });
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  const fork = await screen.findByRole("menuitem", { name: /Fork from the last turn/ });
  expect(fork.getAttribute("aria-disabled")).toBe("true");
  expect(fork.textContent).toContain("Available after the first turn finishes");
});

test("snoozing from the ⋯ menu snoozes it on the daemon and confirms until when", async () => {
  const app = await openThread();
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Snooze" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /^Tomorrow/ }));
  expect(await screen.findByText(/^Snoozed — no notifications until tomorrow/)).toBeTruthy();
  const view = app.daemon.snapshot({ kind: "threads" });
  expect(
    view?.kind === "threads" && view.threads["thread-replay-cursor"]?.snoozedUntil,
  ).toBeGreaterThan(Date.now());
});
