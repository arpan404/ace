import { delegatedDocs, delegatedDocsIds, facts } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

test("forking a finished delegated thread opens a thread of its own with a composer", async () => {
  const app = harness({ clock: () => 10 * 60_000 });
  for (const scenario of delegatedDocs()) app.play(scenario).runUntilBlocked();
  await app.open(`/t/${delegatedDocsIds.child}`);
  const bar = await screen.findByRole("group", { name: "Subagent" });
  expect(screen.queryByRole("combobox", { name: "Message" })).toBeNull();
  await userEvent.click(within(bar).getByRole("button", { name: "Fork from the last turn" }));
  const dialog = await screen.findByRole("dialog", { name: "Fork from here" });
  const title = within(dialog).getByRole("textbox", { name: "Title" });
  await userEvent.clear(title);
  await userEvent.type(title, "Taken over");
  await userEvent.type(
    within(dialog).getByRole("textbox", { name: "First message of the fork" }),
    "Keep going from here",
  );
  await userEvent.click(within(dialog).getByRole("button", { name: "Fork" }));
  await screen.findByRole("heading", { name: "Taken over", level: 1 });
  expect(await screen.findByRole("combobox", { name: "Message" })).toBeTruthy();
  expect(screen.queryByRole("group", { name: "Subagent" })).toBeNull();
});

test("a finished delegated thread without a finished turn shows no Fork action", async () => {
  const app = harness({ clock: () => 10 * 60_000 });
  app.daemon.createThread({
    id: "forkless-parent",
    workspaceId: "relay",
    provider: "claude",
    title: "Forkless parent",
  });
  app.daemon.apply("forkless-parent", [facts.rootAgent("claude"), facts.turn("root")]);
  app.daemon.createThread({
    id: "forkless-child",
    workspaceId: "relay",
    provider: "codex",
    title: "Forkless child",
    parentThreadId: "forkless-parent",
    execution: { provider: "codex", model: "gpt-5.5-codex", options: { effort: "high" } },
  });
  app.daemon.apply("forkless-child", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Write the relay reference"),
    facts.endTurn("root"),
  ]);
  await app.open("/t/forkless-child");
  const bar = await screen.findByRole("group", { name: "Subagent" });
  expect(within(bar).getByRole("button", { name: "Continue" })).toBeTruthy();
  expect(within(bar).queryByRole("button", { name: "Fork from the last turn" })).toBeNull();
});

test("each action on a finished delegated thread's bar says what it does", async () => {
  const app = harness({ clock: () => 10 * 60_000 });
  for (const scenario of delegatedDocs()) app.play(scenario).runUntilBlocked();
  await app.open(`/t/${delegatedDocsIds.child}`);
  const bar = await screen.findByRole("group", { name: "Subagent" });
  const tips = [
    ["button", "Continue", "Reply to this agent"],
    ["button", "Fork from the last turn", "Fork into a new thread"],
    ["link", "Open parent", "Back to Relay docs for 0.9"],
  ] as const;
  for (const [role, name, tip] of tips) {
    await userEvent.hover(within(bar).getByRole(role, { name }));
    expect((await screen.findByRole("tooltip")).textContent).toBe(tip);
    await userEvent.unhover(within(bar).getByRole(role, { name }));
  }
});
