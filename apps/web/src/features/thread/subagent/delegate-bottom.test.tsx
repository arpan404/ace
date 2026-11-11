import { delegatedDocs, delegatedDocsIds, facts } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

test("forking a finished delegated thread opens a thread of its own, ready for its first message", async () => {
  const app = harness({ clock: () => 10 * 60_000 });
  for (const scenario of delegatedDocs()) app.play(scenario).runUntilBlocked();
  await app.open(`/t/${delegatedDocsIds.child}`);
  const bar = await screen.findByRole("group", { name: "Subagent" });
  expect(screen.queryByRole("combobox", { name: "Message" })).toBeNull();
  await userEvent.click(within(bar).getByRole("button", { name: "Fork from the last turn" }));
  // No dialog: the fork opens as its own thread with the composer in place of the bar.
  await screen.findByRole("heading", { name: "Relay protocol reference (fork)", level: 1 });
  expect(screen.queryByRole("dialog")).toBeNull();
  await userEvent.type(
    await screen.findByRole("combobox", { name: "Message" }),
    "Keep going from here{Enter}",
  );
  await within(await screen.findByRole("feed", { name: "Transcript" })).findByText(
    "Keep going from here",
  );
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

test("a thread Spade delegated has no parent to open: no subagent bar, no parent link, its own composer", async () => {
  const app = harness({ clock: () => 10 * 60_000 });
  app.daemon.createThread({
    id: "spade-host",
    workspaceId: "relay",
    provider: "claude",
    title: "Spade",
  });
  app.daemon.createThread({
    id: "spade-child",
    workspaceId: "relay",
    provider: "codex",
    title: "Check the relay",
    parentThreadId: "spade-host",
  });
  app.daemon.apply("spade-child", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Check the relay"),
    facts.endTurn("root"),
  ]);
  app.daemon.spade.status = {
    state: "ready",
    thread: { id: ThreadId.parse("spade-host"), busy: false },
  };
  await app.open("/t/spade-child");
  await screen.findByRole("heading", { name: "Check the relay", level: 1 });
  expect(await screen.findByRole("combobox", { name: "Message" })).toBeTruthy();
  expect(screen.queryByRole("group", { name: "Subagent" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Spade" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Open parent" })).toBeNull();
});

test("with Spade off, a thread Spade delegated still has no parent to open: its parent says it is Spade's", async () => {
  const app = harness({ clock: () => 10 * 60_000 });
  app.daemon.createThread({
    id: "old-spade-host",
    workspaceId: "relay",
    provider: "claude",
    title: "Spade",
    host: "spade",
  });
  app.daemon.createThread({
    id: "old-spade-child",
    workspaceId: "relay",
    provider: "codex",
    title: "Summarize the relay",
    parentThreadId: "old-spade-host",
  });
  app.daemon.apply("old-spade-child", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Summarize the relay"),
    facts.endTurn("root"),
  ]);
  // Spade is off: its status names no host thread.
  app.daemon.spade.status = { state: "off" };
  await app.open("/t/old-spade-child");
  await screen.findByRole("heading", { name: "Summarize the relay", level: 1 });
  expect(await screen.findByRole("combobox", { name: "Message" })).toBeTruthy();
  expect(screen.queryByRole("group", { name: "Subagent" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Open parent" })).toBeNull();
});
