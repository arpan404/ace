import {
  facts,
  flakyCheckout,
  startedConversation,
  startedConversationIds,
  watchingRelay,
} from "@ace/fake-daemon";
import { act, configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { slowReplay } from "@/test/held-replay.ts";
import { harness } from "@/test/harness.tsx";
import { openWorkPanel } from "@/test/open-work.ts";

/*
 * The work log after a reconnect's welcome and before its replay lands: a cached step still in
 * flight neither shimmers nor counts its time, as the live line says Syncing….
 */

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

test("connected again but not caught up: a step in flight neither shimmers nor counts its time", async () => {
  // The daemon's clock starts near 1 s, the reader's 12 s later.
  const app = harness({ uiClock: () => 13_000 });
  const replay = slowReplay(app.daemon);
  app.daemon.createThread({
    id: "parallel",
    workspaceId: "ace",
    title: "Parallel",
    provider: "claude",
  });
  app.daemon.apply("parallel", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Check both builds"),
    facts.tool("root", "slow", {
      kind: "shell",
      title: "slow",
      detail: { kind: "shell", command: "bun run slow" },
    }),
    facts.tool("root", "quick", {
      kind: "shell",
      title: "quick",
      detail: { kind: "shell", command: "bun run quick" },
    }),
    facts.toolDone("root", "quick"),
  ]);
  await app.open("/t/parallel");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const running = { name: /^Running.*bun run slow/ };
  const row = await within(feed).findByRole("button", running);
  expect(row.textContent).toMatch(/12s$/);
  expect(row.querySelector(".step-shimmer")).not.toBeNull();

  await replay.hold(app.client);
  await waitFor(() => expect(feed.querySelector(".step-shimmer")).toBeNull());
  expect(within(feed).getByRole("button", running).textContent).not.toMatch(/\ds$/);

  replay.release(app.client);
  await waitFor(() => expect(feed.querySelector(".step-shimmer")).not.toBeNull());
  expect(within(feed).getByRole("button", running).textContent).toMatch(/12s$/);
});

test("connected again but not caught up: a background group counts nothing as running", async () => {
  const app = harness();
  const replay = slowReplay(app.daemon);
  const scenario = watchingRelay();
  app.play(scenario).runUntilBlocked();
  await app.open(`/t/${scenario.thread.id}`);
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const counted = { name: "2 background tasks · 1 running" };
  expect(await within(feed).findByRole("group", counted)).toBeTruthy();

  await replay.hold(app.client);
  expect(
    await within(feed).findByRole("group", { name: "2 background tasks · Syncing…" }),
  ).toBeTruthy();
  expect(within(feed).queryByRole("group", counted)).toBeNull();

  replay.release(app.client);
  expect(await within(feed).findByRole("group", counted)).toBeTruthy();
});

test("connected again but not caught up: an unfinished thought doesn't say Thinking…", async () => {
  const app = harness();
  const replay = slowReplay(app.daemon);
  app.daemon.createThread({
    id: "thinking",
    workspaceId: "ace",
    title: "Thinking",
    provider: "claude",
  });
  app.daemon.apply("thinking", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Plan it"),
    {
      type: "item.upsert",
      agent: "root",
      item: "thought",
      draft: { type: "reasoning", complete: false, text: "First the parser, then" },
    },
  ]);
  await app.open("/t/thinking");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const thinking = { name: /^Thinking/ };
  expect(await within(feed).findByRole("button", thinking)).toBeTruthy();

  await replay.hold(app.client);
  await waitFor(() => expect(within(feed).queryByRole("button", thinking)).toBeNull());
  expect(within(feed).getByRole("button", { name: /^Syncing…/ })).toBeTruthy();

  replay.release(app.client);
  expect(await within(feed).findByRole("button", thinking)).toBeTruthy();
});

test("connected again but not caught up: the Summary's now line says so instead of what works", async () => {
  const app = harness();
  const replay = slowReplay(app.daemon);
  app.play(flakyCheckout()).runThrough("watcher-started");
  await app.open("/t/thread-checkout");
  await screen.findByRole("combobox", { name: "Message" });
  const work = await openWorkPanel();
  const now = () => within(work).getByRole("status", { name: /^Thread status: / });
  await waitFor(() => expect(now().getAttribute("aria-label")).not.toBe("Thread status: Syncing…"));

  await replay.hold(app.client);
  await waitFor(() => expect(now().getAttribute("aria-label")).toBe("Thread status: Syncing…"));

  replay.release(app.client);
  await waitFor(() => expect(now().getAttribute("aria-label")).not.toBe("Thread status: Syncing…"));
});

test("connected again but not caught up: a started thread's card doesn't say Done while it may have been resumed", async () => {
  const app = harness();
  const replay = slowReplay(app.daemon);
  for (const scenario of startedConversation()) app.play(scenario).runUntilBlocked();
  await app.open(`/t/${startedConversationIds.source}`);
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const card = await within(feed).findByRole("region", { name: "New thread: Separate Codex chat" });
  await waitFor(() => expect(card.textContent).toContain("Done"));

  // The list's replay is held, and another device resumes the started thread meanwhile.
  await replay.hold(app.client);
  act(() =>
    app.daemon.apply(startedConversationIds.started, [
      { type: "turn.started", agent: "root", nativeTurnId: "elsewhere", trigger: "user" },
    ]),
  );
  await waitFor(() => expect(card.textContent).not.toContain("Done"));
  expect(card.textContent).toContain("Syncing…");
  expect(card.querySelector("[data-tone]")).toBeNull();

  replay.release(app.client);
  await waitFor(() => expect(card.textContent).not.toContain("Syncing…"));
  expect(card.textContent).not.toContain("Done");
});

test("connected again but not caught up: a subagent that ended claims no ending while it may have been resumed", async () => {
  const app = harness();
  const replay = slowReplay(app.daemon);
  app.daemon.createThread({
    id: "review",
    workspaceId: "relay",
    provider: "claude",
    title: "Review",
  });
  app.daemon.apply("review", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.tool("root", "spawn-reviewer", {
      kind: "agent.spawn",
      title: "Review the changes",
      detail: { kind: "agent.spawn", description: "Review the diff", childAgent: "reviewer" },
    }),
    facts.subagent("claude", "reviewer", "Reviewer", "spawn-reviewer"),
    facts.turn("reviewer", "spawn"),
    facts.endTurn("reviewer"),
  ]);
  await app.open("/t/review");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const group = await within(feed).findByRole("button", { name: /^1 subagent ran/ });
  expect(group).toBeTruthy();

  await replay.hold(app.client);
  await waitFor(() =>
    expect(within(feed).queryByRole("button", { name: /^1 subagent ran/ })).toBeNull(),
  );
  const stale = within(feed).getByRole("button", { name: /^1 subagent$/ });
  expect(stale.textContent).toContain("Syncing…");
  expect(stale.textContent).not.toMatch(/\bdone\b/i);
  // Its row and the row's details, opened from the group, say the same.
  await userEvent.click(stale);
  const row = await within(feed).findByRole("link", { name: /^Open Reviewer, Syncing…/ });
  await userEvent.hover(row);
  const details = await screen.findByLabelText("Details for Reviewer");
  expect(details.textContent).toContain("Syncing…");
  expect(details.textContent).not.toMatch(/\bdone\b/i);
  await userEvent.unhover(row);
  await userEvent.click(stale);

  replay.release(app.client);
  expect(await within(feed).findByRole("button", { name: /^1 subagent ran/ })).toBeTruthy();
});
