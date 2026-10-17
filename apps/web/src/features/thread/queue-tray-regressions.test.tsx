import { replayCursor } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());
const threadId = ThreadId.parse("thread-replay-cursor");
const rows = () =>
  within(screen.getByRole("list", { name: "Queued messages" })).getAllByRole("listitem");
const queue = async (app: ReturnType<typeof harness>) =>
  (await app.client.request({ type: "queue.get", threadId })).queue;

test("Steer accepts a running root turn before its first transcript item", async () => {
  const app = harness();
  const scenario = replayCursor();
  const first = scenario.steps[0];
  if (first?.kind !== "facts") throw new Error("no initial facts");
  app
    .play({
      ...scenario,
      steps: [{ ...first, facts: first.facts.filter((fact) => fact.type !== "item.upsert") }],
    })
    .runUntilBlocked();
  await app.open(`/t/${threadId}`);
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await userEvent.type(
    await screen.findByRole("combobox", { name: "Message" }),
    "Before any output{Enter}",
  );
  const steer = await screen.findByRole("button", { name: "Steer" });
  await waitFor(() => expect(steer.getAttribute("aria-disabled")).toBe("false"));
  await userEvent.click(steer);
  expect(await within(feed).findByText("Before any output")).toBeTruthy();
  expect((await queue(app)).total).toBe(0);
});

test("Steer stays available when no root turn runs and sends the message at once", async () => {
  const app = harness({ snapshotItems: 1 });
  // Keep older transcript pages outside this device's retained window.
  app.daemon.holdRequests("items.page");
  app.play(replayCursor()).runThrough("finding");
  app.daemon.apply(threadId, [
    {
      type: "item.upsert",
      agent: "audit",
      item: "latest-child",
      draft: {
        type: "message",
        role: "assistant",
        complete: true,
        parts: [{ type: "text", text: "Only retained child output" }],
      },
    },
  ]);
  await app.open(`/t/${threadId}`);
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  expect(within(feed).queryByText("Only retained child output")).toBeNull();
  await userEvent.type(
    await screen.findByRole("combobox", { name: "Message" }),
    "Follow the live turn{Enter}",
  );
  const steer = await screen.findByRole("button", { name: "Steer" });
  await waitFor(() => expect(steer.getAttribute("aria-disabled")).toBe("false"));
  // The root's turn ends while its subagents and the relay keep running, and the provider has
  // said it will start a turn of its own: the message stays queued for that turn.
  act(() =>
    app.daemon.apply(threadId, [
      { type: "turn.ended", agent: "root", outcome: "completed" },
      { type: "wake.expected", agent: "root", until: 4_102_444_800_000 },
    ]),
  );
  await waitFor(() => expect(within(feed).queryByText("Follow the live turn")).toBeNull());
  // Steering never needs a running turn: it starts the next one now.
  await waitFor(() => expect(steer.getAttribute("aria-disabled")).toBe("false"));
  await userEvent.click(steer);
  expect(await within(feed).findByText("Follow the live turn")).toBeTruthy();
  expect((await queue(app)).total).toBe(0);
});

test("a queued message reaches the agent when the root's turn ends while subagents keep working", async () => {
  const app = harness();
  app.play(replayCursor()).runThrough("finding");
  await app.open(`/t/${threadId}`);
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await userEvent.type(
    await screen.findByRole("combobox", { name: "Message" }),
    "After your turn{Enter}",
  );
  await waitFor(() => expect(rows()).toHaveLength(1));
  expect(within(feed).queryByText("After your turn")).toBeNull();
  act(() =>
    app.daemon.apply(threadId, [{ type: "turn.ended", agent: "root", outcome: "completed" }]),
  );
  expect(await within(feed).findByText("After your turn")).toBeTruthy();
  expect((await queue(app)).total).toBe(0);
  // The subagents still run: the thread keeps reading as working.
  const lease = app.client.thread(threadId);
  try {
    await waitFor(() => expect(lease.store.thread?.status.state).toBe("working"));
  } finally {
    lease.release();
  }
});

test.each(["save", "take back"])(
  "an edit moved beyond the visible page can still %s",
  async (action) => {
    const app = harness();
    app.play(replayCursor()).runThrough("finding");
    await app.open(`/t/${threadId}`);
    await screen.findByRole("combobox", { name: "Message" });
    await act(async () => {
      for (let index = 0; index < 17; index++)
        await app.client.command(
          {
            type: "thread.send",
            threadId,
            input: [{ type: "text", text: `Saved ${index}` }],
            delivery: "queue",
          },
          {},
          `hidden-edit-${index}`,
        );
    });
    await waitFor(() => expect(rows()).toHaveLength(16));
    const tray = screen.getByRole("list", { name: "Queued messages" });
    const row = within(tray).getAllByRole("listitem")[15];
    if (!row) throw new Error("no last visible row");
    const edit = within(row).getByRole("button", { name: "Edit queued message" });
    await waitFor(() => expect(edit.hasAttribute("disabled")).toBe(false));
    await userEvent.click(edit);
    const editor = await screen.findByRole("textbox", { name: "Queued message text" });
    const before = await queue(app);
    const entry = before.messages[15];
    const last = before.messages[16];
    if (!entry || !last) throw new Error("missing saved rows");
    await act(async () => {
      await app.client.command(
        {
          type: "queue.move",
          threadId,
          messageId: entry.id,
          after: last.id,
          expectedRevision: before.revision,
        },
        {},
        "another-device-move",
      );
    });
    await waitFor(() => expect(within(tray).queryByText("Saved 15")).toBeNull());
    expect(
      screen.queryByText("This message has left the queue. Your edits are still here to copy."),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Save changes" }).hasAttribute("disabled")).toBe(
      false,
    );
    expect(
      screen.getByRole("button", { name: "Take back to composer" }).hasAttribute("disabled"),
    ).toBe(false);
    if (action === "save") {
      await userEvent.clear(editor);
      await userEvent.type(editor, "Revised hidden message");
      await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await waitFor(async () =>
        expect((await queue(app)).messages.at(-1)?.input).toEqual([
          { type: "text", text: "Revised hidden message" },
        ]),
      );
    } else {
      await userEvent.click(screen.getByRole("button", { name: "Take back to composer" }));
      await waitFor(() =>
        expect(screen.getByRole("combobox", { name: "Message" }).textContent).toBe("Saved 15"),
      );
      expect((await queue(app)).messages.some((message) => message.id === entry.id)).toBe(false);
    }
  },
);

test("a pending keyboard reorder preserves focus deliberately moved to the composer", async () => {
  const app = harness();
  app.play(replayCursor()).runThrough("finding");
  await app.open(`/t/${threadId}`);
  const composer = await screen.findByRole("combobox", { name: "Message" });
  await userEvent.type(composer, "First{Enter}Second{Enter}");
  const ready = await screen.findByRole("button", { name: "Reorder queued message 2" });
  await waitFor(() => expect(ready.getAttribute("aria-disabled")).toBe("false"));
  act(() => app.daemon.refuseConnections(true));
  await waitFor(() => expect(app.client.state).not.toBe("ready"));
  // The connection takes the composer's strip; its queue indicator brings the queue back.
  await userEvent.click(await screen.findByRole("button", { name: "Show 2 queued messages" }));
  const handle = await screen.findByRole("button", { name: "Reorder queued message 2" });
  handle.focus();
  await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");
  await waitFor(() => expect(rows()[0]?.textContent).toContain("Second"));
  await userEvent.click(composer);
  await userEvent.type(composer, "Keep typing");
  act(() => app.daemon.refuseConnections(false));
  await waitFor(() => expect(app.client.state).toBe("ready"), { timeout: 8_000 });
  await waitFor(async () =>
    expect((await queue(app)).messages.map((message) => message.input)).toEqual([
      [{ type: "text", text: "Second" }],
      [{ type: "text", text: "First" }],
    ]),
  );
  await waitFor(() => expect(handle.getAttribute("aria-disabled")).toBe("false"));
  expect(document.activeElement).toBe(composer);
  expect(composer.textContent).toBe("Keep typing");
});
