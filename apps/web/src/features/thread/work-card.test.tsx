import { facts, workCardScenario } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());
async function open(state: Parameters<typeof workCardScenario>[0]) {
  const app = harness();
  const fixture = workCardScenario(state);
  app.play(fixture).runUntilBlocked();
  await app.open(`/t/${fixture.thread.id}`);
  const toggle = await screen.findByRole("button", { name: /^Work card/ });
  await userEvent.click(toggle);
  const card = await screen.findByRole("complementary", { name: "Work card" });
  return { app, card, toggle, threadId: fixture.thread.id };
}

test("a clean worktree has a plain icon, its full branch, and Create PR", async () => {
  const { card, toggle } = await open("worktree");
  expect(toggle.getAttribute("aria-label")).toBe("Work card · Nothing pending");
  expect(screen.queryByRole("img", { name: /Work pending|Work needs you/ })).toBeNull();
  expect(within(card).getByText("fix/restart-retry").textContent).toBe("fix/restart-retry");
  expect(within(card).getByRole("heading", { level: 2 }).textContent).toBe("relay · Worktree");
  expect(within(card).getByText("Up to date")).toBeTruthy();
  await userEvent.click(within(card).getByRole("button", { name: "Create PR" }));
  expect(await screen.findByRole("dialog", { name: "Open a pull request" })).toBeTruthy();
});

test("pending changes and agents get a blue mark and a spoken tooltip summary", async () => {
  const { card, toggle } = await open("changes");
  expect(screen.getByRole("img", { name: "Work pending" })).toBeTruthy();
  expect(toggle.getAttribute("aria-label")).toContain(
    "2 changed · PR #188 · 2 agents running · 1 background command",
  );
  await userEvent.hover(toggle);
  expect((await screen.findByRole("tooltip")).textContent).toContain(
    "2 changed · PR #188 · 2 agents running",
  );
  await userEvent.unhover(toggle);
  await userEvent.click(within(card).getByRole("button", { name: "Commit" }));
  const dialog = await screen.findByRole("dialog", { name: "Commit changes" });
  expect(
    within(dialog)
      .getByRole("checkbox", { name: "Push after committing" })
      .getAttribute("aria-checked"),
  ).toBe("false");
});

test("a failed agent gets an amber mark and opens its work", async () => {
  const { card } = await open("failed");
  expect(screen.getByRole("img", { name: "Work needs you" })).toBeTruthy();
  const agents = within(card).getByRole("region", { name: "Agents" });
  await userEvent.click(
    within(agents).getByRole("button", { name: "Open Check supervisor logs: Failed" }),
  );
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  expect(
    await within(panel).findByRole("tab", { name: /Check supervisor logs/, selected: true }),
  ).toBeTruthy();
});

test("only running background commands appear and their output opens", async () => {
  const { card } = await open("changes");
  const background = within(card).getByRole("region", { name: "Background" });
  expect(within(background).queryByText("git log -5")).toBeNull();
  await userEvent.click(
    within(background).getByRole("button", { name: "Show bun run dev: watching" }),
  );
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  expect(await within(panel).findByRole("tab", { name: /Watch/, selected: true })).toBeTruthy();
  expect(await within(panel).findByText("bun run dev")).toBeTruthy();
});

test("the background section disappears when its last command ends", async () => {
  const { app, card, threadId } = await open("changes");
  expect(within(card).getByRole("region", { name: "Background" })).toBeTruthy();
  act(() =>
    app.daemon.apply(threadId, [{ type: "background.ended", task: "watch", status: "completed" }]),
  );
  await waitFor(() =>
    expect(within(card).queryByRole("region", { name: "Background" })).toBeNull(),
  );
});

test("finished agents collapse after three while running agents remain visible", async () => {
  const { app, card, threadId } = await open("many-agents");
  const agents = within(card).getByRole("region", { name: "Agents" });
  expect(within(agents).getByText("2 running")).toBeTruthy();
  await userEvent.click(within(agents).getByRole("button", { name: "7 done" }));
  expect(
    within(agents).getByRole("button", { name: "Open Read restart history 3: done" }),
  ).toBeTruthy();
  act(() => app.daemon.apply(threadId, [facts.endTurn("worker-0"), facts.endTurn("worker-1")]));
  await waitFor(() => expect(within(agents).queryByText("2 running")).toBeNull());
  expect(
    within(agents).getByRole("button", { name: "Open Write retry tests 1: done" }),
  ).toBeTruthy();
});

test("a merged branch offers no new PR and hides empty work sections", async () => {
  const { card } = await open("merged");
  expect(within(card).getByText("Up to date")).toBeTruthy();
  expect(within(card).queryByRole("button", { name: "Create PR" })).toBeNull();
  expect(within(card).getByRole("button", { name: /Pull request #188.*merged/ })).toBeTruthy();
  expect(within(card).queryByRole("region", { name: "Background" })).toBeNull();
  expect(within(card).queryByRole("region", { name: "Agents" })).toBeNull();
});

test("the link field waits for a click and Escape returns focus to the icon", async () => {
  const { card, toggle } = await open("remote");
  expect(within(card).getByRole("heading", { level: 2 }).textContent).toContain(
    "· Local · Build server",
  );
  expect(within(card).queryByRole("textbox", { name: "Link pull request…" })).toBeNull();
  await userEvent.click(within(card).getByRole("button", { name: "Link a pull request" }));
  expect(document.activeElement).toBe(
    within(card).getByRole("textbox", { name: "Link pull request…" }),
  );
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("complementary", { name: "Work card" })).toBeNull();
  expect(document.activeElement).toBe(toggle);
});

test("a rejected push turns the mark amber and a successful retry clears it", async () => {
  const { app, card } = await open("worktree");
  app.daemon.refuseCommands("git_non_fast_forward", "git.push");
  await userEvent.click(within(card).getByRole("button", { name: "Git actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Push" }));
  expect(await screen.findAllByText("Couldn't push")).not.toHaveLength(0);
  expect(await screen.findByRole("img", { name: "Work needs you" })).toBeTruthy();
  app.daemon.restoreRequests();
  await userEvent.click(within(card).getByRole("button", { name: "Git actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Push" }));
  await waitFor(() => expect(screen.queryByRole("img", { name: "Work needs you" })).toBeNull());
});
