import { expect, test } from "vitest";
import { Command } from "@ace/protocol";
import { ThreadOrganizer } from "../thread-organizer.ts";
import { harness, scriptFrames, start, end, question, task } from "./test-support.ts";

test("settlement and deletion follow real human interaction and background execution facts", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, question)] }], frames);
  const organizer = new ThreadOrganizer(h.store, undefined, h.clock.now, () => () => {});
  try {
    const id = await h.create();
    const client = await h.connect("device");
    const command = async (type: "thread.settle" | "thread.delete", commandId: string) => {
      client.send({
        type: "command",
        command: Command.parse({
          id: commandId,
          deviceId: "device",
          payload: { type, threadId: id },
        }),
      });
      return client.next();
    };
    expect(h.store.getThread(id)?.status.state).toBe("needs_you");
    expect(await command("thread.settle", "waiting-human")).toMatchObject({
      ok: false,
      error: "thread_not_done",
    });
    h.store.appendEvents(
      id,
      [
        {
          type: "thread.client.updated",
          changes: { details: { linkedPr: { number: 42, state: "merged" } } },
        },
      ],
      h.clock.now(),
    );
    await organizer.sweep();
    expect(h.store.getThread(id)?.settledAt).toBeUndefined();
    const context = h.contexts[0];
    if (!context) throw new Error("Missing provider boundary");
    context.onFrame(
      frames.frame(
        { type: "interaction.closed", interaction: "approval", state: "resolved" },
        task,
        end,
      ),
    );
    await h.engine.flush();
    expect(h.store.getThread(id)?.status).toMatchObject({
      state: "waiting",
      on: "background_task",
    });
    expect(await command("thread.delete", "running-background")).toMatchObject({
      ok: false,
      error: "thread_busy",
    });
    await organizer.sweep();
    expect(h.store.getThread(id)?.settledAt).toBeUndefined();
    context.onFrame(frames.frame({ type: "background.ended", task: "shell", status: "completed" }));
    await h.engine.flush();
    await organizer.sweep();
    expect(h.store.getThread(id)?.settledReason).toBe("pr_merged");
    expect(await command("thread.delete", "completed-tree")).toMatchObject({ ok: true });
    expect(h.errors).toEqual([]);
  } finally {
    await organizer.close();
    await h.close();
  }
});
