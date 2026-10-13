import { longHistory, replayCursor } from "@ace/fake-daemon";
import type { CommandPayload } from "@ace/protocol";
import { createMemoryHistory } from "@tanstack/react-router";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

/** A thread open on screen, with every command the daemon receives kept. */
async function open(path: string, play: (made: ReturnType<typeof harness>) => void) {
  const history = createMemoryHistory({ initialEntries: [path] });
  const made = harness({ history });
  play(made);
  const sent: CommandPayload[] = [];
  const receive = made.daemon.command.bind(made.daemon);
  made.daemon.command = (command) => {
    sent.push(command.payload);
    return receive(command);
  };
  await made.open(path);
  await screen.findByRole("combobox", { name: "Message" });
  const of = (type: CommandPayload["type"]) => sent.filter((payload) => payload.type === type);
  return { history, of };
}

const working = (made: ReturnType<typeof harness>) =>
  void made.play(replayCursor()).runThrough("finding");

/** Archive the thread (⇧⌘A; this test browser is not Apple: ⌥⇧Ctrl+A), once its shortcuts load. */
async function archiveKey() {
  await waitFor(
    async () => {
      if (!screen.queryByRole("dialog") && !screen.queryByText(/^Archived ·/))
        await userEvent.keyboard("{Control>}{Alt>}{Shift>}a{/Shift}{/Alt}{/Control}");
      expect(screen.queryByRole("dialog") ?? screen.queryByText(/^Archived ·/)).toBeTruthy();
    },
    { timeout: 5000 },
  );
}

test("⇧⌘A on a working thread asks first, and Archive, keep running leaves its agents alone; Undo returns to it", async () => {
  const { history, of } = await open("/t/thread-replay-cursor", working);
  await archiveKey();
  const ask = screen.getByRole("dialog", { name: "Archive a running thread?" });
  expect(within(ask).getByText(/Still running: .*2 subagents/)).toBeTruthy();
  expect(of("thread.archive")).toEqual([]);

  await userEvent.click(within(ask).getByRole("button", { name: "Archive, keep running" }));
  await waitFor(() => expect(of("thread.archive")).toHaveLength(1));
  await waitFor(() => expect(history.location.pathname).not.toBe("/t/thread-replay-cursor"));
  expect(of("thread.interrupt")).toEqual([]);

  await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
  await waitFor(() => expect(history.location.pathname).toBe("/t/thread-replay-cursor"));
  await waitFor(() => expect(of("thread.unarchive")).toHaveLength(1));
});

test("Stop & archive stops the whole tree and its commands, then archives", async () => {
  const { of } = await open("/t/thread-replay-cursor", working);
  await archiveKey();
  await userEvent.click(screen.getByRole("button", { name: "Stop & archive" }));
  await waitFor(() => expect(of("thread.archive")).toHaveLength(1));
  expect(of("thread.interrupt")).toEqual([expect.objectContaining({ cascade: true })]);
  expect(of("background_task.stop").length).toBeGreaterThan(0);
});

test("Cancel archives nothing and stays on the thread", async () => {
  const { history, of } = await open("/t/thread-replay-cursor", working);
  await archiveKey();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Archive a running thread?" })).toBeNull(),
  );
  expect(of("thread.archive")).toEqual([]);
  expect(history.location.pathname).toBe("/t/thread-replay-cursor");
});

test("a thread with nothing running archives at once, with no question", async () => {
  const { of } = await open(
    "/t/thread-router",
    (made) => void made.play(longHistory(2)).runUntilBlocked(),
  );
  await archiveKey();
  expect(screen.queryByRole("dialog", { name: "Archive a running thread?" })).toBeNull();
  await waitFor(() => expect(of("thread.archive")).toHaveLength(1));
});
