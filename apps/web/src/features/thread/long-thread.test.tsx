import { multiDayDemo, type Scenario } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

const threadId = "thread-multi-day";
const day = 24 * 60 * 60 * 1000;

/**
 * A five-day thread of `turns` turns (an ask, a command, an edit, a subagent, twenty progress
 * notes and an answer). The daemon's snapshot keeps `tail` items, so older turns are only
 * reachable by jumping.
 */
async function openLong(turns: number, tail: number, extra?: (scenario: Scenario) => Scenario) {
  let now = 10 * day;
  const app = harness({ snapshotItems: tail, clock: () => (now += 1) });
  const scenario = multiDayDemo(threadId, turns, { scans: 20 });
  const script = app.play(extra ? extra(scenario) : scenario);
  script.runUntilBlocked();
  await app.open(`/t/${threadId}`);
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  return { app, script, feed };
}

const ask = (n: number) => `Migrate checkpoint ${n}, inspect files and report failures.`;
const answer = (n: number) => new RegExp(`^Checkpoint ${n} completed\\. Migration paths validated`);

async function openTurns(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Turns" }));
  return screen.findByRole("listbox", { name: "Turns of this thread" });
}

test("the turn timeline lists every turn with its digest and jumps to one", async () => {
  const user = userEvent.setup();
  const { feed } = await openLong(12, 12);
  expect(within(feed).queryByText(ask(2))).toBeNull();

  const list = await openTurns(user);
  list.focus();
  await user.keyboard("{Home}");
  const first = await within(list).findByRole("option", { name: /^Turn 1: / });
  expect(first.getAttribute("aria-selected")).toBe("true");
  // The digest: two tools (the command and the edit), the file and its lines, the approval.
  expect(first.getAttribute("aria-label")).toBe(
    `Turn 1: ${ask(1)} Completed, 3 tools, 1 file, +2 −1, 1 approval, 1 subagent`,
  );
  await user.keyboard("{ArrowDown}{Enter}");

  const jumped = await screen.findByRole("status", { name: "Jumped" });
  expect(jumped.textContent).toContain("Jumped to turn 2");
  expect(jumped.textContent).toContain("of 12");
  expect(await within(feed).findByText(ask(2))).toBeTruthy();
  // Only the window shows: the live end is not there, and the gap says what lies between.
  expect(within(feed).queryByText(answer(12))).toBeNull();
  const gap = screen.getByRole("group", { name: "Gap to live" });
  expect(gap.textContent).toMatch(/\d+ newer turns until live/);

  await user.click(within(gap).getByRole("button", { name: "Jump to live" }));
  await waitFor(() => expect(screen.queryByRole("status", { name: "Jumped" })).toBeNull());
  expect(await within(feed).findByText(answer(12))).toBeTruthy();
  expect(within(feed).queryByText(ask(2))).toBeNull();
});

test("a turn already in the live tail is scrolled to without leaving it", async () => {
  const user = userEvent.setup();
  const { feed } = await openLong(6, 200);
  const list = await openTurns(user);
  list.focus();
  await user.keyboard("{End}{ArrowUp}{Enter}");
  expect(within(feed).getByText(answer(6))).toBeTruthy();
  expect(screen.queryByRole("status", { name: "Jumped" })).toBeNull();
});

test("older turns fold into one-line digests that open and fold again", async () => {
  const user = userEvent.setup();
  const { feed } = await openLong(6, 200);
  // The three newest turns show whole; the others are one row each.
  expect(within(feed).getByText(answer(6))).toBeTruthy();
  expect(within(feed).getByText(answer(4))).toBeTruthy();
  expect(within(feed).queryByText(answer(2))).toBeNull();
  const folded = within(feed).getByRole("button", { name: `Turn 2: ${ask(2)} Show the turn` });
  await waitFor(() => expect(folded.textContent).toContain("3 tools"));
  expect(folded.textContent).toContain("1 approval");

  await user.click(folded);
  expect(await within(feed).findByText(answer(2))).toBeTruthy();
  await user.click(within(feed).getByRole("button", { name: "Turn 2. Fold the turn" }));
  await waitFor(() => expect(within(feed).queryByText(answer(2))).toBeNull());
});

test("Jump to live counts what reached the thread while the reader was in its history", async () => {
  const user = userEvent.setup();
  const { app, feed } = await openLong(8, 12);
  const list = await openTurns(user);
  list.focus();
  await user.keyboard("{Home}{Enter}");
  await screen.findByRole("status", { name: "Jumped" });
  // The window's end offers the live end, and so does the pill over the transcript.
  expect(screen.getAllByRole("button", { name: "Jump to live" })).toHaveLength(2);

  // The agent keeps working on the live end meanwhile.
  await act(async () => {
    app.daemon.apply(threadId, [
      { type: "turn.started", agent: "root", nativeTurnId: "turn-9", trigger: "user" },
      {
        type: "item.upsert",
        agent: "root",
        item: "late-1",
        draft: {
          type: "message",
          role: "assistant",
          complete: true,
          parts: [{ type: "text", text: "Late finding one." }],
        },
      },
      {
        type: "item.upsert",
        agent: "root",
        item: "late-2",
        draft: {
          type: "message",
          role: "assistant",
          complete: true,
          parts: [{ type: "text", text: "Late finding two." }],
        },
      },
    ]);
  });
  const pill = await screen.findByRole("button", { name: "Jump to live, 2 new" });
  expect(within(feed).queryByText("Late finding two.")).toBeNull();
  await user.click(pill);
  expect(await within(feed).findByText("Late finding two.")).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("status", { name: "Jumped" })).toBeNull());
});
