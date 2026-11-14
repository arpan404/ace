import type { Fact } from "@ace/core";
import { facts, flakyCheckout, replayCursor } from "@ace/fake-daemon";
import type { CommandPayload } from "@ace/protocol";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { slowReplay } from "@/test/held-replay.ts";
import { harness } from "@/test/harness.tsx";
import { openWorkCard, openWorkPanel } from "@/test/open-work.ts";

/*
 * The window after a reconnect's welcome and before its replay lands: connected, but every copy
 * still says what was true before the drop. Nothing may claim it as live or act on it.
 */

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

/** A harness whose daemon can hold the replay, with every command it receives kept. */
function slowDaemon() {
  const app = harness();
  const replay = slowReplay(app.daemon);
  const received: CommandPayload[] = [];
  const command = app.daemon.command.bind(app.daemon);
  app.daemon.command = (sent) => {
    received.push(sent.payload);
    return command(sent);
  };
  const of = (type: CommandPayload["type"]) => received.filter((payload) => payload.type === type);
  return { app, replay, of };
}

const reviewing: Fact[] = [
  facts.rootAgent("claude"),
  facts.turn("root"),
  facts.tool("root", "spawn-reviewer", {
    kind: "agent.spawn",
    title: "Review the changes",
    detail: { kind: "agent.spawn", description: "Review the diff", childAgent: "reviewer" },
  }),
  facts.subagent("claude", "reviewer", "Reviewer", "spawn-reviewer"),
  facts.turn("reviewer", "spawn"),
  facts.subagent("claude", "child", "Child", "spawn-child", { parent: "reviewer" }),
  facts.turn("child"),
];

test("connected again but not caught up: a subagent's page and its details card claim no state", async () => {
  const { app, replay } = slowDaemon();
  app.daemon.createThread({
    id: "review",
    workspaceId: "relay",
    provider: "claude",
    title: "Review changes",
  });
  app.daemon.apply("review", reviewing);
  await app.open("/t/review");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const card = await within(feed).findByRole("region", { name: "1 subagent" });
  await userEvent.click(within(card).getByRole("link", { name: /^Open Reviewer,/ }));
  await screen.findByRole("heading", { level: 1, name: "Reviewer" });
  const bar = screen.getByRole("group", { name: "Subagent" });
  expect(within(bar).getByText(/^Working for/)).toBeTruthy();

  await replay.hold(app.client);
  await waitFor(() => expect(within(bar).queryByText(/^Working for/)).toBeNull());
  expect(within(bar).getByText("Syncing…")).toBeTruthy();
  expect(within(bar).queryByRole("button", { name: /^Stop/ })).toBeNull();
  const details = await openWorkCard();
  const agents = within(details).getByRole("region", { name: "Agents" });
  expect(
    within(agents).getByRole("button", { name: "Open parent Review changes, Syncing…" }),
  ).toBeTruthy();
  expect(within(agents).getByLabelText("Reviewer, Syncing…, shown")).toBeTruthy();
  expect(within(agents).queryByText("Done")).toBeNull();
  expect(within(agents).queryByText(/^Working/)).toBeNull();

  replay.release(app.client);
  expect(await within(bar).findByText(/^Working for/)).toBeTruthy();
});

test("connected again but not caught up: a background command's Stop in the Summary waits", async () => {
  const { app, replay, of } = slowDaemon();
  app.play(flakyCheckout()).runThrough("watcher-started");
  await app.open("/t/thread-checkout");
  await screen.findByRole("combobox", { name: "Message" });
  const work = await openWorkPanel();
  const row = await within(work).findByRole("treeitem", {
    name: /^\$ bun run test --watch checkout: running/,
  });
  // Its Stop sits beside it in the row's frame.
  const frame = row.closest<HTMLElement>("[data-row-frame]");
  if (!frame) throw new Error("The command's row has no frame");
  const stop = () => within(frame).getByRole<HTMLButtonElement>("button", { name: "Stop" });
  expect(stop().disabled).toBe(false);

  await replay.hold(app.client);
  await waitFor(() => expect(stop().disabled).toBe(true));
  await userEvent.click(stop());
  expect(of("background_task.stop")).toEqual([]);

  replay.release(app.client);
  await waitFor(() => expect(stop().disabled).toBe(false));
});

test("connected again but not caught up: an agent shell's header says so, with no state and no ticking age", async () => {
  const { app, replay } = slowDaemon();
  app.play(flakyCheckout()).runThrough("watcher-started");
  await app.open("/t/thread-checkout");
  await screen.findByRole("combobox", { name: "Message" });
  const work = await openWorkPanel();
  await userEvent.click(
    await within(work).findByRole("treeitem", { name: /^\$ bun run test --watch checkout: / }),
  );
  // The shell's header: the row around its command.
  const command = (await screen.findAllByTitle("bun run test --watch checkout")).find(
    (element) => element.tagName === "CODE",
  );
  const header = command?.parentElement;
  if (!header) throw new Error("No shell header");
  await waitFor(() => expect(header.textContent).toContain("Running"));

  await replay.hold(app.client);
  await waitFor(() => expect(header.textContent).toContain("Syncing…"));
  expect(header.textContent).not.toContain("Running");
  replay.release(app.client);
  await waitFor(() => expect(header.textContent).toContain("Running"));
});

/** Archive the open thread with its shortcut (this test browser is not Apple: ⌥⇧Ctrl+A). */
const archiveKey = () => userEvent.keyboard("{Control>}{Alt>}{Shift>}a{/Shift}{/Alt}{/Control}");

test("connected again but not caught up: archive doesn't decide from the old list, and a Stop & archive asked before waits too", async () => {
  const { app, replay, of } = slowDaemon();
  app.play(replayCursor()).runThrough("finding");
  await app.open("/t/thread-replay-cursor");
  await screen.findByRole("combobox", { name: "Message" });
  // Asked while the list was current.
  await waitFor(
    async () => {
      if (!screen.queryByRole("dialog")) await archiveKey();
      expect(screen.getByRole("dialog", { name: "Archive a running thread?" })).toBeTruthy();
    },
    { timeout: 5_000 },
  );

  await replay.hold(app.client);
  await userEvent.click(screen.getByRole("button", { name: "Stop & archive" }));
  expect(await screen.findByText("Not changed yet")).toBeTruthy();
  // And asked again now: nothing is decided from the list as it was before the drop.
  await archiveKey();
  expect(screen.queryByRole("dialog", { name: "Archive a running thread?" })).toBeNull();
  expect(of("thread.interrupt")).toEqual([]);
  expect(of("thread.archive")).toEqual([]);

  // Once the replay lands the list is current again (the first test shows actions coming back).
  replay.release(app.client);
});
