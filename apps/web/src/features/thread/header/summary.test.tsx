import { dedupeReconnect, replayCursor } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { summaryPlacement } from "./summary.tsx";

beforeEach(() => localStorage.clear());

async function heroWithSummary() {
  const app = harness();
  app.play(replayCursor()).runUntilBlocked();
  app.play(dedupeReconnect()).runThrough("finding");
  await app.open("/t/thread-dedupe");
  await screen.findByRole("feed", { name: "Transcript" });
  await userEvent.click(screen.getByRole("button", { name: "Pin thread summary" }));
  return { app, card: await screen.findByRole("complementary", { name: "Thread summary" }) };
}

test("the pinned summary names the project and adds up the thread's own edits, with what is still uncommitted beneath", async () => {
  const { card } = await heroWithSummary();
  expect(within(card).getByRole("heading", { level: 2 }).textContent).toBe("ace");
  const changes = within(card).getByRole("button", { name: /^Changes/ });
  await waitFor(() => expect(changes.getAttribute("aria-label")).toMatch(/\d+ added, \d+ removed/));
  expect(changes.textContent).toContain("fix/replay-dedupe");
  expect(changes.textContent).toMatch(/uncommitted/i);
});

test("each subagent has a mark that opens its own tab, and the count opens the tree", async () => {
  const { card } = await heroWithSummary();
  const subagents = within(card).getByRole("region", { name: "Subagents" });
  await waitFor(() => expect(subagents.textContent).toMatch(/1 running · 1 done/));
  await userEvent.click(within(subagents).getByRole("button", { name: "Open reconnect-audit" }));
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  expect(
    await within(panel).findByRole("tab", { name: "reconnect-audit", selected: true }),
  ).toBeTruthy();
  await userEvent.click(within(subagents).getByRole("button", { name: /running/ }));
  expect(await within(panel).findByRole("tab", { name: "Agents", selected: true })).toBeTruthy();
});

test("Sources lists the files attached to the thread's messages, each opening as a file tab, and + opens the composer's Add menu", async () => {
  const { card } = await heroWithSummary();
  const sources = within(card).getByRole("region", { name: "Sources" });
  await within(sources).findByRole("button", { name: "outbox.ts" });
  expect(within(sources).getByRole("button", { name: "README.md" })).toBeTruthy();

  await userEvent.click(within(sources).getByRole("button", { name: "outbox.ts" }));
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  expect(await within(panel).findByRole("tab", { name: "outbox.ts", selected: true })).toBeTruthy();

  await userEvent.click(within(sources).getByRole("button", { name: "Add files and context" }));
  expect(await screen.findByRole("menuitem", { name: /^Files/ })).toBeTruthy();
});

test("the summary's ⋯ lists project and git actions, saying why the ones it can't do are off", async () => {
  const { app } = await heroWithSummary();
  await userEvent.click(screen.getByRole("button", { name: "Project and git actions" }));
  const menu = await screen.findByRole("menu");
  const branch = within(menu).getByRole("menuitem", { name: /Create branch/ });
  expect(branch.getAttribute("aria-disabled")).toBe("true");
  expect(branch.textContent).toContain("can't create a branch yet");
  // The agents are still working: the checkout stays put.
  const move = within(menu).getByRole("menuitem", { name: /Move to worktree/ });
  expect(move.textContent).toMatch(/Already in a worktree|Wait for the agents/);

  await userEvent.click(within(menu).getByRole("menuitem", { name: /Open terminal/ }));
  const bottom = await screen.findByRole("region", { name: "Bottom panel" });
  await waitFor(() => expect(within(bottom).getAllByRole("tab").length).toBeGreaterThan(0));
  await waitFor(() => expect(app.daemon.terminals.list("thread-dedupe").length).toBe(1));
});

test("⌥⌘O and the card's own pin both unpin the summary", async () => {
  await heroWithSummary();
  await act(async () => {
    await userEvent.keyboard("{Alt>}{Meta>}o{/Meta}{/Alt}");
  });
  expect(screen.queryByRole("complementary", { name: "Thread summary" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Pin thread summary" }));
  expect(screen.getByRole("complementary", { name: "Thread summary" })).toBeTruthy();
  await userEvent.click(
    within(screen.getByRole("complementary", { name: "Thread summary" })).getByRole("button", {
      name: "Unpin thread summary",
    }),
  );
  expect(screen.queryByRole("complementary", { name: "Thread summary" })).toBeNull();
});

test("the card floats in the gutter beside a wide column, insets narrower text, and stacks above a narrow one", () => {
  expect(summaryPlacement(1400)).toBe("gutter");
  expect(summaryPlacement(1076)).toBe("inset");
  expect(summaryPlacement(560)).toBe("inline");
});
