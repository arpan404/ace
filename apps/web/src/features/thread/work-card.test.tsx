import { workCardScenario } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { openWorkPanel } from "@/test/open-work.ts";

beforeEach(() => localStorage.clear());
async function open(state: Parameters<typeof workCardScenario>[0]) {
  const app = harness();
  const fixture = workCardScenario(state);
  app.play(fixture).runUntilBlocked();
  await app.open(`/t/${fixture.thread.id}`);
  return { app, work: await openWorkPanel(), threadId: fixture.thread.id };
}

test("a clean checkout shows its branch and can open a PR form", async () => {
  const { work } = await open("worktree");
  expect(within(work).getByText("fix/restart-retry")).toBeTruthy();
  expect(within(work).getByText("Up to date")).toBeTruthy();
  await userEvent.click(within(work).getByRole("button", { name: "Commit and push options" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Create PR…" }));
  expect(await screen.findByRole("dialog", { name: "Open a pull request" })).toBeTruthy();
});

test("commit-only stays available from Work's git options", async () => {
  const { work } = await open("changes");
  await userEvent.click(within(work).getByRole("button", { name: "Commit and push options" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Commit only…" }));
  const dialog = await screen.findByRole("dialog", { name: "Commit to fix/restart-retry" });
  expect(
    within(dialog)
      .getByRole("checkbox", { name: "Push after committing" })
      .getAttribute("aria-checked"),
  ).toBe("false");
});

test("a retrying child remains active while it waits on its provider", async () => {
  const { app, threadId, work } = await open("changes");
  act(() => app.daemon.apply(threadId, [{ type: "retry", agent: "worker-0", on: "rate_limit" }]));
  await within(work).findByRole("treeitem", { name: "Write retry tests: Waiting on rate limit" });
  expect(within(work).queryByRole("treeitem", { name: "Write retry tests: Done" })).toBeNull();
});

test("a failed child opens its own work without leaking its raw error into the tree", async () => {
  const { work } = await open("failed");
  expect(within(work).queryByText("The test command failed. Check its output.")).toBeNull();
  await userEvent.click(
    within(work).getByRole("treeitem", { name: "Check supervisor logs: Failed" }),
  );
  expect(
    await screen.findByRole("tab", { name: /Check supervisor logs/, selected: true }),
  ).toBeTruthy();
});

test("running background commands open their output and disappear when finished", async () => {
  const { app, threadId, work } = await open("changes");
  expect(within(work).queryByText("git log -5")).toBeNull();
  await userEvent.click(within(work).getByRole("button", { name: "Show bun run dev output" }));
  expect(await screen.findByRole("tab", { name: /Watch/, selected: true })).toBeTruthy();
  await openWorkPanel();
  act(() =>
    app.daemon.apply(threadId, [{ type: "background.ended", task: "watch", status: "completed" }]),
  );
  await waitFor(() =>
    expect(within(work).queryByRole("region", { name: "Background" })).toBeNull(),
  );
});

test("a merged branch hides new-PR actions", async () => {
  const { work } = await open("merged");
  expect(within(work).getByRole("button", { name: /Pull request #188.*merged/ })).toBeTruthy();
  await userEvent.click(within(work).getByRole("button", { name: "Project actions" }));
  expect(screen.queryByRole("menuitem", { name: "Create PR…" })).toBeNull();
});

test("Git forms keep Work mounted and the link field waits for a click", async () => {
  const { work } = await open("remote");
  expect(within(work).getByRole("heading", { name: "Build server" })).toBeTruthy();
  expect(within(work).queryByRole("textbox", { name: "Link pull request…" })).toBeNull();
  await userEvent.click(within(work).getByRole("button", { name: "Project actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Link a pull request" }));
  expect(document.activeElement).toBe(
    within(work).getByRole("textbox", { name: "Link pull request…" }),
  );
});

test("opening and using Work preserves the composer draft", async () => {
  const { work } = await open("worktree");
  const input = screen.getByRole("combobox", { name: "Message" });
  await userEvent.type(input, "Continue this draft");
  expect(input.textContent).toBe("Continue this draft");
  expect(screen.getByRole("tabpanel", { name: "Work" })).toBe(work);
  await userEvent.keyboard("{Control>}{Shift>}a{/Shift}{/Control}");
  await waitFor(() => expect(screen.queryByRole("tabpanel", { name: "Work" })).toBeNull());
  await openWorkPanel();
  expect(input.textContent).toBe("Continue this draft");
});
