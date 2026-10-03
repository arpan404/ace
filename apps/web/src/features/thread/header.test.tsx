import { facts, flakyCheckout, replayCursor, type Scenario } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { ThreadId } from "@ace/protocol";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

async function openThread(which: "replay" | "checkout" = "replay") {
  const app = harness();
  if (which === "replay") app.play(replayCursor()).runThrough("finding");
  else app.play(flakyCheckout()).runThrough("explorer-spawned");
  await app.open(which === "replay" ? "/t/thread-replay-cursor" : "/t/thread-checkout");
  await screen.findByRole("feed", { name: "Transcript" });
  return app;
}

test("Run starts the project's default script in a new terminal in the bottom panel", async () => {
  const app = await openThread();
  await userEvent.click(await screen.findByRole("button", { name: "Run bun run dev:relay" }));
  const bottom = await screen.findByRole("region", { name: "Bottom panel" });
  await waitFor(() =>
    expect(
      within(bottom).getByRole("tab", { name: "Terminal" }).getAttribute("aria-selected"),
    ).toBe("true"),
  );
  expect(
    await within(bottom).findByRole("tab", { name: "dev:relay", selected: true }),
  ).toBeTruthy();
  expect(await screen.findByText("Running bun run dev:relay")).toBeTruthy();
  expect(app.daemon.terminals.list("thread-replay-cursor").map((t) => t.name)).toEqual([
    "dev:relay",
  ]);
});

test("Run's picker runs another of the project's scripts", async () => {
  const app = await openThread();
  await userEvent.click(await screen.findByRole("button", { name: "Choose a script" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /bun run soak/ }));
  expect(await screen.findByText("Running bun run soak")).toBeTruthy();
  expect(app.daemon.terminals.list("thread-replay-cursor").map((t) => t.name)).toEqual(["soak"]);
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
  await userEvent.click(within(commit).getByRole("button", { name: "Commit" }));
  expect(await screen.findByText("Committed")).toBeTruthy();

  await userEvent.click(await screen.findByRole("button", { name: "Push" }));
  expect(await screen.findByText("Pushed")).toBeTruthy();

  await userEvent.click(await screen.findByRole("button", { name: "Create PR" }));
  const pr = await screen.findByRole("dialog", { name: "Open a pull request" });
  await userEvent.click(within(pr).getByRole("button", { name: "Create PR" }));
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
  await userEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
  const field = await screen.findByRole("textbox", { name: "Thread title" });
  await userEvent.clear(field);
  await userEvent.type(field, "Cold-start replay cap{Enter}");
  expect(
    await screen.findByRole("heading", { level: 1, name: "Cold-start replay cap" }),
  ).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("archiving from the ⋯ menu leaves the thread", async () => {
  await openThread();
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));
  expect(await screen.findByText("Archived · Replay cursor resets on every resume")).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("feed", { name: "Transcript" })).toBeNull());
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
