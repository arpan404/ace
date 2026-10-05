import { facts, flakyCheckout, replayCursor, type Scenario } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { ThreadId } from "@ace/protocol";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

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

test("Run starts the project's default script in a terminal tab of its own in the bottom panel", async () => {
  // Before the agent starts the relay in the background.
  const app = await openThread("replay", "delegated");
  await userEvent.click(await screen.findByRole("button", { name: "Run bun run dev:relay" }));
  const bottom = await screen.findByRole("region", { name: "Bottom panel" });
  // The panel opening on the script's tab is the only confirmation.
  expect(
    await within(bottom).findByRole("tab", { name: "dev:relay", selected: true }),
  ).toBeTruthy();
  await waitFor(() =>
    expect(within(bottom).getByRole("log", { name: "dev:relay output" }).textContent).toContain(
      "relay listening on ws://127.0.0.1:8787",
    ),
  );
  expect(screen.queryByText("Running bun run dev:relay")).toBeNull();
  expect(app.daemon.terminals.list("thread-replay-cursor").map((t) => t.name)).toEqual([
    "dev:relay",
  ]);
});

test("Run's picker runs another of the project's scripts", async () => {
  const app = await openThread();
  await userEvent.click(await screen.findByRole("button", { name: "Choose a script" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /bun run soak/ }));
  expect(await screen.findByRole("tab", { name: "soak", selected: true })).toBeTruthy();
  expect(app.daemon.terminals.list("thread-replay-cursor").map((t) => t.name)).toEqual(["soak"]);
});

test("running a script that is still running goes back to its terminal instead of a second one", async () => {
  const app = await openThread("replay", "delegated");
  await userEvent.click(await screen.findByRole("button", { name: "Run bun run dev:relay" }));
  const bottom = await screen.findByRole("region", { name: "Bottom panel" });
  await within(bottom).findByRole("tab", { name: "dev:relay", selected: true });

  await userEvent.click(screen.getByRole("button", { name: "Choose a script" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /bun run soak/ }));
  await within(bottom).findByRole("tab", { name: "soak", selected: true });

  await userEvent.click(screen.getByRole("button", { name: "Run bun run dev:relay" }));
  expect(
    await within(bottom).findByRole("tab", { name: "dev:relay", selected: true }),
  ).toBeTruthy();
  expect(app.daemon.terminals.list("thread-replay-cursor").map((t) => t.name)).toEqual([
    "dev:relay",
    "soak",
  ]);
});

test("Run on a script an agent already runs in the background shows the agent's shell, not a second copy", async () => {
  const app = await openThread();
  await userEvent.click(await screen.findByRole("button", { name: "Run bun run dev:relay" }));
  const bottom = await screen.findByRole("region", { name: "Bottom panel" });
  expect(
    await within(bottom).findByRole("tab", { name: "dev:relay", selected: true }),
  ).toBeTruthy();
  expect(await within(bottom).findByText("Agent shell")).toBeTruthy();
  expect(within(bottom).getByRole("log", { name: "dev:relay output" }).textContent).toContain(
    "relay listening on ws://127.0.0.1:8787",
  );
  // One tab for it, and nothing started in the daemon.
  expect(within(bottom).getAllByRole("tab", { name: /dev:relay/ })).toHaveLength(1);
  expect(app.daemon.terminals.list("thread-replay-cursor")).toEqual([]);
});

test("a project without scripts says so in Run's menu", async () => {
  const app = harness();
  app.daemon.setScripts("relay", []);
  app.play(replayCursor()).runThrough("finding");
  await app.open("/t/thread-replay-cursor");
  await screen.findByRole("feed", { name: "Transcript" });

  await userEvent.click(await screen.findByRole("button", { name: "Choose a script" }));
  const item = await screen.findByRole("menuitem", { name: /No scripts in this project/ });
  expect(item.getAttribute("aria-disabled")).toBe("true");
  expect(within(item).getByText("Add one to package.json and it shows here")).toBeTruthy();
});

test("when the scripts can't be read, Run's menu says so and reads them again", async () => {
  const app = harness();
  app.daemon.failRequests("workspace.request");
  app.play(replayCursor()).runThrough("finding");
  await app.open("/t/thread-replay-cursor");
  await screen.findByRole("feed", { name: "Transcript" });

  await userEvent.click(await screen.findByRole("button", { name: "Choose a script" }));
  expect(await screen.findByText("Couldn't read this project's scripts")).toBeTruthy();
  app.daemon.restoreRequests();
  await userEvent.click(screen.getByRole("menuitem", { name: "Try again" }));
  expect(await screen.findByRole("button", { name: "Run bun run dev:relay" })).toBeTruthy();
});

test("Open launches the checkout in the editor, and picking another makes it the default", async () => {
  await openThread();
  const launched = vi.spyOn(window, "open").mockImplementation(() => null);
  await userEvent.click(await screen.findByRole("button", { name: "Choose an editor" }));
  expect(
    await screen.findByRole("menuitem", { name: /Visual Studio Code\s*default/ }),
  ).toBeTruthy();
  await userEvent.click(screen.getByRole("menuitem", { name: "Zed" }));
  expect(await screen.findByText("Opened in Zed")).toBeTruthy();
  expect(launched).toHaveBeenCalledWith("zed://file/Users/dev/relay", "_self");

  await userEvent.click(screen.getByRole("button", { name: "Choose an editor" }));
  expect(await screen.findByRole("menuitem", { name: /Zed\s*default/ })).toBeTruthy();
  launched.mockRestore();
});

test("the git control walks the branch from Commit to Push to Create PR to the PR", async () => {
  const app = await openThread("checkout");
  const opened = vi.spyOn(window, "open").mockImplementation(() => null);
  // Commit holds its place, disabled, until the checkout has been read.
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Commit" }).getAttribute("aria-disabled")).toBeNull(),
  );
  await userEvent.click(screen.getByRole("button", { name: "Commit" }));
  const commit = await screen.findByRole("dialog", { name: "Commit changes" });
  const message = within(commit).getByRole("textbox", { name: "Commit message" });
  expect((message as HTMLInputElement).value).toBe("Fix flaky checkout test");
  await userEvent.clear(message);
  await userEvent.type(message, "Wait for the payment intent before asserting");
  await within(commit).findByRole("list", { name: "Files to commit" });
  await userEvent.click(within(commit).getByRole("button", { name: commitButton }));
  expect(await screen.findByText("Committed")).toBeTruthy();

  await userEvent.click(await screen.findByRole("button", { name: "Push" }));
  expect(await screen.findByText("Pushed")).toBeTruthy();

  await userEvent.click(await screen.findByRole("button", { name: "Create PR" }));
  const pr = await screen.findByRole("dialog", { name: "Open a pull request" });
  await userEvent.click(within(pr).getByRole("button", { name: /^Create PR/ }));
  await userEvent.click(await screen.findByRole("button", { name: "PR #1" }));
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

test("Commit lists exactly the files git reports, leaves untracked ones out until picked, and commits only what is ticked", async () => {
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
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Commit" }).getAttribute("aria-disabled")).toBeNull(),
  );
  await userEvent.click(screen.getByRole("button", { name: "Commit" }));
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
  expect(box(".env.local").getAttribute("aria-checked")).toBe("false");
  expect(box("src/checkout.ts").getAttribute("aria-checked")).toBe("true");
  expect(box("src/payments/wait.ts").getAttribute("aria-checked")).toBe("true");
  expect(within(dialog).getByText("· 2 picked")).toBeTruthy();

  await userEvent.click(box("src/checkout.ts"));
  await userEvent.click(within(dialog).getByRole("button", { name: commitButton }));
  expect(await screen.findByText("Committed")).toBeTruthy();
  // The rename went in with its old path; the unticked files stayed uncommitted.
  expect(app.daemon.workspace.gitStatus("thread-checkout").map((file) => file.path)).toEqual([
    ".env.local",
    "src/checkout.ts",
  ]);
});

test("Commit can't run with nothing picked, and View diff shows the changes instead", async () => {
  const app = await openThread("checkout");
  app.daemon.workspace.setGitStatus("thread-checkout", [
    { path: "notes.md", status: "untracked", additions: 1, deletions: 0, binary: false },
  ]);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Commit" }).getAttribute("aria-disabled")).toBeNull(),
  );
  await userEvent.click(screen.getByRole("button", { name: "Commit" }));
  const dialog = await screen.findByRole("dialog", { name: "Commit changes" });
  await within(dialog).findByRole("list", { name: "Files to commit" });
  expect(within(dialog).getByRole("button", { name: commitButton }).hasAttribute("disabled")).toBe(
    true,
  );

  await userEvent.click(within(dialog).getByRole("button", { name: "View diff" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Commit changes" })).toBeNull());
  const panel = await screen.findByRole("region", { name: /panel$/i });
  expect(within(panel).getByRole("tab", { name: /^Changes/, selected: true })).toBeTruthy();
});

test("Create PR says why it can't run when the checkout has no GitHub or GitLab remote", async () => {
  const local: Scenario = {
    thread: {
      id: "thread-no-remote",
      workspaceId: "scratch",
      title: "Sketch a parser",
      provider: "claude",
      details: {
        workspace: { id: "scratch", name: "scratch", path: "/Users/dev/scratch" },
        mode: "local",
        worktree: "/Users/dev/scratch",
        branch: "sketch/parser",
        head: "a".repeat(40),
        ahead: 0,
        behind: 0,
        baseBranch: "main",
      },
    },
    steps: [{ kind: "facts", facts: [facts.rootAgent("claude")] }],
  };
  const app = harness();
  app.play(local).runUntilBlocked();
  await app.open("/t/thread-no-remote");
  const create = await screen.findByRole("button", { name: "Create PR" });
  expect(create.getAttribute("aria-disabled")).toBe("true");
  expect(create.getAttribute("aria-description")).toBe(
    "The daemon found no GitHub or GitLab remote for this checkout.",
  );
  await userEvent.click(create);
  expect(screen.queryByRole("dialog", { name: "Open a pull request" })).toBeNull();
});

test("Commit stays in the header, disabled, when the thread's directory isn't a git checkout", async () => {
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
  const commit = await screen.findByRole("button", { name: "Commit" });
  await waitFor(() => expect(commit.getAttribute("aria-description")).toBe("Not a git checkout"));
  expect(commit.getAttribute("aria-disabled")).toBe("true");
  expect(screen.getByRole("button", { name: "Git actions" })).toHaveProperty("disabled", true);
});

test("with a linked PR, the git menu opens it and says why a draft PR can't be created", async () => {
  const linked: Scenario = {
    thread: {
      id: "thread-linked-pr",
      workspaceId: "api",
      title: "Cap restart retries",
      provider: "claude",
      details: {
        workspace: { id: "api", name: "api", path: "/Users/dev/api" },
        mode: "local",
        worktree: "/Users/dev/api",
        branch: "fix/restart-retry",
        head: "b".repeat(40),
        ahead: 0,
        behind: 0,
        baseBranch: "main",
        diff: { files: 3, additions: 64, deletions: 12 },
        linkedPr: { number: 188, state: "open" },
        repository: { forge: "github", host: "github.com", owner: "acme", name: "api" },
      },
    },
    steps: [{ kind: "facts", facts: [facts.rootAgent("claude")] }],
  };
  const app = harness();
  app.play(linked).runUntilBlocked();
  await app.open("/t/thread-linked-pr");
  const opened = vi.spyOn(window, "open").mockImplementation(() => null);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Git actions" })).toHaveProperty("disabled", false),
  );
  await userEvent.click(screen.getByRole("button", { name: "Git actions" }));
  const draft = await screen.findByRole("menuitem", { name: /Create draft PR/ });
  expect(draft.getAttribute("aria-disabled")).toBe("true");
  expect(draft.textContent).toContain("PR #188 is already open");
  await userEvent.click(screen.getByRole("menuitem", { name: "Open PR #188" }));
  expect(opened).toHaveBeenCalledWith(
    "https://github.com/acme/api/pull/188",
    "_blank",
    "noopener,noreferrer",
  );
  opened.mockRestore();
});

test("the commit dialog lists the checkout's uncommitted files and can push too, with ⌘↵", async () => {
  const app = await openThread("checkout");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Commit" }).getAttribute("aria-disabled")).toBeNull(),
  );
  await userEvent.click(screen.getByRole("button", { name: "Commit" }));
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
  const app = harness();
  app.play(flakyCheckout()).runThrough("explorer-spawned");
  await app.open("/t/thread-checkout");
  await screen.findByRole("feed", { name: "Transcript" });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Commit" }).getAttribute("aria-disabled")).toBeNull(),
  );
  await userEvent.click(screen.getByRole("button", { name: "Commit" }));
  const commit = await screen.findByRole("dialog", { name: "Commit changes" });
  await within(commit).findByRole("list", { name: "Files to commit" });
  await userEvent.click(within(commit).getByRole("checkbox", { name: "Push after committing" }));
  await userEvent.click(within(commit).getByRole("button", { name: /^Commit & push/ }));
  await userEvent.click(await screen.findByRole("button", { name: "Create PR" }));
  const pr = await screen.findByRole("dialog", { name: "Open a pull request" });
  await userEvent.click(within(pr).getByRole("checkbox", { name: /Draft/ }));
  await userEvent.click(within(pr).getByRole("button", { name: /^Create draft PR/ }));
  expect(await screen.findByText(/^Draft pull request #\d+ opened$/)).toBeTruthy();
});

test("View diff in the git menu shows the Changes tab", async () => {
  await openThread();
  await userEvent.click(await screen.findByRole("button", { name: "Git actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /View diff/ }));
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  expect(
    within(panel)
      .getByRole("tab", { name: /^Changes/ })
      .getAttribute("aria-selected"),
  ).toBe("true");
});

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

test("deleting from the ⋯ menu leaves the thread with an Undo window, and Undo keeps it", async () => {
  const app = await openThread();
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Delete thread" }));
  const undo = await screen.findByRole("button", { name: "Undo" });
  expect(screen.getByText("Deleted · Replay cursor resets on every resume")).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("feed", { name: "Transcript" })).toBeNull());
  await userEvent.click(undo);
  const view = app.daemon.snapshot({ kind: "threads" });
  expect(view?.kind === "threads" && view.threads["thread-replay-cursor"]).toBeTruthy();
});

test("the ⋯ menu offers the same thread actions, in the same order, as the row's context menu", async () => {
  await openThread();
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  const header = (await screen.findAllByRole("menuitem")).map((item) => item.textContent ?? "");
  await userEvent.keyboard("{Escape}");
  const row = within(screen.getByRole("navigation", { name: "Threads" })).getByRole("link", {
    name: /Replay cursor resets/,
  });
  await userEvent.pointer({ keys: "[MouseRight]", target: row });
  const menu = await screen.findByRole("menu", { name: /^Actions for/ });
  const context = within(menu)
    .getAllByRole("menuitem")
    .map((item) => (item.textContent ?? "").replace(/(Shift\+N|R)$/, ""));
  // The thread screen adds a side chat and the agent tree, and shows its own shortcuts.
  const shortcut = /(Alt\+Ctrl\+[RP]|(Alt\+)?Shift\+Ctrl\+A|⌥⌘[RP]|⇧⌘A)$/;
  expect(
    header
      .filter((label) => !/^(Open agent tree|New side chat)/.test(label))
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

test("New side chat in the ⋯ menu opens the Side chat tab", async () => {
  await openThread();
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  const item = await screen.findByRole("menuitem", { name: /^New side chat/ });
  expect(item.textContent).toMatch(/Alt\+Ctrl\+S|⌥⌘S/);
  await userEvent.click(item);
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  expect(within(panel).getByRole("tab", { name: "Side chat", selected: true })).toBeTruthy();
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
  expect(await screen.findByText(/^Snoozed until tomorrow/)).toBeTruthy();
  const view = app.daemon.snapshot({ kind: "threads" });
  expect(
    view?.kind === "threads" && view.threads["thread-replay-cursor"]?.snoozedUntil,
  ).toBeGreaterThan(Date.now());
});
