import { workCardScenario, type Scenario } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import {
  currentCheckout,
  gitAction,
  machineRow,
  openWorkCard,
  openWorkPanel,
  workButton,
} from "@/test/open-work.ts";

beforeEach(() => localStorage.clear());

type Details = Partial<NonNullable<Scenario["thread"]["details"]>>;

/** A work-card fixture thread with its card opened from the header's details icon. */
async function open(state: Parameters<typeof workCardScenario>[0], details: Details = {}) {
  const app = harness();
  const fixture = workCardScenario(state);
  fixture.thread.details = { ...fixture.thread.details, ...details };
  app.play(fixture).runUntilBlocked();
  const view = await app.open(`/t/${fixture.thread.id}`);
  return { app, view, threadId: fixture.thread.id, card: await openWorkCard() };
}

function ahead(app: ReturnType<typeof harness>, threadId: string) {
  const view = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse(threadId) });
  return view && "thread" in view ? view.thread.details?.ahead : undefined;
}

test("the details card holds the environment and git only; what runs lives in Summary", async () => {
  const { card } = await open("changes");
  const environment = within(card).getByRole("region", { name: "Environment" });
  expect(within(environment).getByRole("button", { name: machineRow })).toBeTruthy();
  expect(within(environment).getByRole("button", { name: /^Open in / })).toBeTruthy();
  expect(within(environment).getByRole("button", { name: "Add project script" })).toBeTruthy();
  expect(await currentCheckout()).toBe("Local");
  const git = within(card).getByRole("region", { name: "Git" });
  expect(
    await within(git).findByRole("button", { name: "Branch fix/restart-retry, switch branch" }),
  ).toBeTruthy();
  // The background command and the subagents have one home: the Summary tab.
  expect(within(card).queryByRole("region", { name: "Running" })).toBeNull();
  expect(within(card).queryByRole("button", { name: /^Show .* output$/ })).toBeNull();
  expect(within(card).queryByRole("button", { name: /subagents? working/ })).toBeNull();
  await userEvent.keyboard("{Escape}");
  const summary = await openWorkPanel();
  expect(
    await within(summary).findByRole("button", { name: "Show bun run dev output" }),
  ).toBeTruthy();
  expect(within(summary).getByRole("tree", { name: "Agent tree" })).toBeTruthy();
});

test("the git action offers Commit & push while the checkout has uncommitted changes", async () => {
  const { card } = await open("changes");
  const git = within(card).getByRole("region", { name: "Git" });
  await userEvent.click(await within(git).findByRole("button", { name: "Commit & push" }));
  const dialog = await screen.findByRole("dialog", { name: "Commit to fix/restart-retry" });
  expect(
    within(dialog)
      .getByRole("checkbox", { name: "Push after committing" })
      .getAttribute("aria-checked"),
  ).toBe("true");
});

test("the Changes header offers the details card's git action and opens the same commit form", async () => {
  const { card } = await open("changes");
  const git = within(card).getByRole("region", { name: "Git" });
  expect(await within(git).findByRole("button", { name: "Commit & push" })).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await userEvent.click(await screen.findByRole("button", { name: "Right panel" }));
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await userEvent.click(within(panel).getByRole("tab", { name: /^Changes/ }));
  const toolbar = await within(panel).findByRole("toolbar", { name: "Changes" });
  await userEvent.click(await within(toolbar).findByRole("button", { name: "Commit & push" }));
  const dialog = await screen.findByRole("dialog", { name: "Commit to fix/restart-retry" });
  expect(
    within(dialog)
      .getByRole("checkbox", { name: "Push after committing" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  // Its chevron holds every other step, as the card's does.
  await userEvent.keyboard("{Escape}");
  await userEvent.click(within(toolbar).getByRole("button", { name: "More git actions" }));
  expect(await screen.findByRole("menuitem", { name: "Commit…" })).toBeTruthy();
});

test("with only unpushed commits the git action is Push, and once pushed it moves on to Create PR", async () => {
  const { app, threadId, card } = await open("worktree", { ahead: 2 });
  const git = within(card).getByRole("region", { name: "Git" });
  expect(await within(git).findByText("2 commits not pushed")).toBeTruthy();
  expect(within(git).queryByRole("button", { name: "Commit & push" })).toBeNull();
  await userEvent.click(within(git).getByRole("button", { name: "Push" }));
  const confirm = await screen.findByRole("dialog", { name: "Push fix/restart-retry?" });
  expect(ahead(app, threadId)).toBe(2);
  await userEvent.click(within(confirm).getByRole("button", { name: "Push" }));
  await waitFor(() => expect(ahead(app, threadId)).toBe(0));
  // The push confirms itself in a toast.
  expect(await screen.findByText("Pushed")).toBeTruthy();
  const after = within(await openWorkCard()).getByRole("region", { name: "Git" });
  expect(await within(after).findByRole("button", { name: "Create PR" })).toBeTruthy();
  expect(within(after).queryByText("2 commits not pushed")).toBeNull();
});

test("a clean checkout's git action opens the pull request form", async () => {
  const { card } = await open("worktree");
  expect(await currentCheckout()).toBe("Worktree");
  await userEvent.click(await within(card).findByRole("button", { name: "Create PR" }));
  expect(await screen.findByRole("dialog", { name: "Open a pull request" })).toBeTruthy();
});

test("commit without pushing stays available behind More git actions", async () => {
  await open("changes");
  await gitAction("Commit…");
  const dialog = await screen.findByRole("dialog", { name: "Commit to fix/restart-retry" });
  expect(
    within(dialog)
      .getByRole("checkbox", { name: "Push after committing" })
      .getAttribute("aria-checked"),
  ).toBe("false");
});

test("the card's uncommitted count names its scope and opens Changes on that same scope", async () => {
  const { card } = await open("changes");
  const row = await within(card).findByRole("button", {
    name: "Uncommitted changes, 2 files: 34 added, 1 removed",
  });
  expect(row.textContent).toContain("Uncommitted");
  await userEvent.click(row);
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  expect(await within(panel).findByRole("tab", { name: /^Changes/, selected: true })).toBeTruthy();
  expect(await within(panel).findByRole("button", { name: "Scope: Uncommitted" })).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Thread details" })).toBeNull());
});

test("the PR line names the pull request once, with its state and no stack noise", async () => {
  const { card } = await open("changes");
  expect(
    await within(card).findByRole("button", {
      name: /^Open pull request #188: Retry budget, open/,
    }),
  ).toBeTruthy();
  expect(within(card).getAllByText(/#188/)).toHaveLength(1);
  expect(
    within(card).queryByText(/Stack membership unavailable|missing or inaccessible/),
  ).toBeNull();
});

test("a merged PR reads merged without Merge, and the git action starts a new PR", async () => {
  const { card } = await open("merged");
  expect(
    await within(card).findByRole("button", { name: /^Open pull request #188.*merged/ }),
  ).toBeTruthy();
  expect(within(card).queryByRole("button", { name: /^Merge pull request/ })).toBeNull();
  expect(within(card).getByRole("button", { name: "Create PR" })).toBeTruthy();
});

test("Merge on a PR the forge can't read says so without the server's raw error", async () => {
  const { app, card } = await open("changes");
  app.daemon.refuseCommands("private_server_detail_571", "forge.pr.status");
  await userEvent.click(
    await within(card).findByRole("button", { name: "Merge pull request #188" }),
  );
  expect(await screen.findByRole("alertdialog", { name: "Couldn't merge" })).toBeTruthy();
  expect(screen.queryByText(/private_server_detail_571/)).toBeNull();
  expect(screen.queryByRole("dialog", { name: /^Merge PR/ })).toBeNull();
});

test("a remote thread's card names its machine, and the link field opens only when asked", async () => {
  const { card } = await open("remote");
  expect(within(card).getByRole("button", { name: /^Build server, / })).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Pull request" })).toBeNull();
  await gitAction("Link a pull request…");
  const dialog = await screen.findByRole("dialog", { name: "Link an existing pull request" });
  expect(within(dialog).getByRole("textbox", { name: "Pull request" })).toBeTruthy();
});

test("opening and closing the card keeps the composer draft", async () => {
  await open("worktree");
  const input = screen.getByRole("combobox", { name: "Message" });
  await userEvent.type(input, "Continue this draft");
  expect(input.textContent).toBe("Continue this draft");
  await openWorkCard();
  await userEvent.click(await workButton());
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Thread details" })).toBeNull());
  expect(input.textContent).toBe("Continue this draft");
});
