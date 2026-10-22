import { expect, test } from "vitest";
import type { ThreadId } from "@ace/protocol";
import { ThreadOrganizer } from "../thread-organizer.ts";
import { end, harness, scriptFrames, start } from "./test-support.ts";

/*
 * A merged pull request settles its thread once. When the person reopens the thread to keep
 * working, it stays open after each turn instead of settling again over the same merge.
 */
test("a thread reopened after its merged PR settled it stays open after the next turn", async () => {
  const frames = scriptFrames();
  const turn = { on: "send" as const, frames: [frames.frame(start, end)] };
  // Each settle ends the provider session; the next message opens a new one.
  const close = { on: "close" as const };
  const h = await harness([turn, close, turn, close], frames);
  const organizer = new ThreadOrganizer(h.store, undefined, h.clock.now, () => () => {});
  const link = (id: ThreadId, number: number) =>
    h.store.appendEvents(
      id,
      [
        {
          type: "thread.client.updated",
          changes: { details: { linkedPr: { number, state: "merged" } } },
        },
      ],
      h.clock.now(),
    );
  const send = async (id: ThreadId, text: string) => {
    h.command(
      { type: "thread.send", threadId: id, input: [{ type: "text", text }] },
      "device",
      text,
    );
    await h.engine.flush();
  };
  try {
    const id = await h.create();
    link(id, 42);
    await organizer.sweep();
    expect(h.store.getThread(id)?.settledReason).toBe("pr_merged");

    // The person comes back to it: the new turn reopens the thread, and it stays open after.
    await send(id, "one more thing");
    expect(h.store.getThread(id)?.status.state).toBe("done");
    await organizer.sweep();
    expect(h.store.getThread(id)?.settledAt).toBeUndefined();

    // A different pull request merging still settles it.
    link(id, 43);
    await organizer.sweep();
    expect(h.store.getThread(id)?.settledReason).toBe("pr_merged");
    expect(h.errors).toEqual([]);
  } finally {
    await organizer.close();
    await h.close();
  }
});
