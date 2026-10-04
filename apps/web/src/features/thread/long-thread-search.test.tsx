import { facts, multiDayDemo } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

const threadId = "thread-multi-day";
const day = 24 * 60 * 60 * 1000;

/** Twelve turns; the daemon's snapshot keeps the last twelve items only. */
async function openLong() {
  let now = 10 * day;
  const app = harness({ snapshotItems: 12, clock: () => (now += 1) });
  app.play(multiDayDemo(threadId, 12, { scans: 20 })).runUntilBlocked();
  return app;
}

async function search(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.keyboard("{Meta>}f{/Meta}");
  const bar = await screen.findByRole("search", { name: "Search this thread" });
  await user.type(within(bar).getByRole("textbox", { name: "Search this thread" }), text);
  return bar;
}

test("⌘F finds words anywhere in the thread and Enter jumps to the hit", async () => {
  const user = userEvent.setup();
  const app = await openLong();
  await app.open(`/t/${threadId}`);
  const feed = await screen.findByRole("feed", { name: "Transcript" });

  // Only checkpoint 7's command failed; its output is far older than the live tail.
  const bar = await search(user, "validation failed");
  const results = await within(bar).findByRole("listbox", { name: "Results" });
  const hit = await within(results).findByRole("option", { name: /Turn 7/ });
  expect(within(hit).getByText("validation failed").tagName).toBe("MARK");
  expect(within(bar).getByText("1 result")).toBeTruthy();

  await user.keyboard("{Enter}");
  const jumped = await screen.findByRole("status", { name: "Jumped" });
  expect(jumped.textContent).toContain("Jumped to turn 7");
  expect(
    await within(feed).findByText("Migrate checkpoint 7, inspect files and report failures."),
  ).toBeTruthy();
  expect(within(bar).getByText("1 of 1 result")).toBeTruthy();
});

test("filters keep a search to messages, tool output, commands, files or errors", async () => {
  const user = userEvent.setup();
  const app = await openLong();
  await app.open(`/t/${threadId}`);
  const bar = await search(user, "validation failed");
  await within(bar).findByText("1 result");

  await user.click(within(bar).getByRole("button", { name: "Messages" }));
  expect(await within(bar).findByText("Nothing in this thread matches.")).toBeTruthy();
  await user.click(within(bar).getByRole("button", { name: "Tool output" }));
  expect(await within(bar).findByText("1 result")).toBeTruthy();

  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("search", { name: "Search this thread" })).toBeNull(),
  );
});

test("with Subagents on, a hit in a linked subagent thread opens that thread at the hit", async () => {
  const user = userEvent.setup();
  const app = await openLong();
  // An auditor the main agent delegated to, running in its own linked thread.
  app.daemon.createThread({
    id: "thread-auditor",
    workspaceId: "ace",
    title: "Audit the migrated permissions",
    provider: "codex",
  });
  app.daemon.apply("thread-auditor", [
    facts.rootAgent("codex"),
    facts.message("root", "finding", "assistant", "The zebra-needle permission was widened."),
  ]);
  app.daemon.apply(threadId, [
    {
      type: "agent.seen",
      agent: "auditor",
      parent: "root",
      origin: "ace",
      fidelity: "full",
      native: { provider: "codex", nativeId: "auditor" },
      cwd: "/Users/dev/acme",
      name: "Permissions auditor",
    },
    {
      type: "agent.external",
      agent: "auditor",
      threadId: ThreadId.parse("thread-auditor"),
      status: { state: "done" },
    },
  ]);
  await app.open(`/t/${threadId}`);

  const bar = await search(user, "zebra-needle");
  expect(await within(bar).findByText("Nothing in this thread matches.")).toBeTruthy();
  await user.click(within(bar).getByRole("switch", { name: "Subagents" }));
  const hit = await within(bar).findByRole("option", { name: /Subagent/ });
  await user.click(hit);

  expect(
    await screen.findByRole("heading", { level: 1, name: "Audit the migrated permissions" }),
  ).toBeTruthy();
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  expect(await within(feed).findByText(/zebra-needle permission was widened/)).toBeTruthy();
});
