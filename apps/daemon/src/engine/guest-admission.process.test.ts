import { expect, test } from "vitest";
import { ThreadId, type CommandPayload } from "@ace/protocol";
import { harness, scriptFrames } from "./test-support.ts";

test("a guest thread never runs an agent: sends, resumes and agents' messages are refused", async () => {
  const h = await harness([{ on: "send", frames: [] }], scriptFrames());
  try {
    const id = ThreadId.parse("machine-guest-1");
    h.engine.guests.create({
      id,
      workspaceId: h.workspace,
      title: "Linux box · Fix the login flow",
      provider: "codex",
      cwd: h.home,
      guest: { host: "linux-box", name: "Linux box" },
    });
    const refused = {
      ok: false,
      error: "guest_thread",
      detail: "This thread holds work from Linux box; it has no agent here.",
    };
    const send: CommandPayload = {
      type: "thread.send",
      threadId: id,
      input: [{ type: "text", text: "Hello?" }],
    };
    // The person, from the thread's composer.
    expect(h.command(send)).toMatchObject(refused);
    // A local agent messaging it, as agent tools do.
    expect(h.internalCommand({ ...send, trigger: "parent_agent" }, "agent-message")).toMatchObject(
      refused,
    );
    // Continue after a stop, and resuming its queue.
    expect(h.command({ type: "thread.resume", threadId: id, expectedRevision: 0 })).toMatchObject(
      refused,
    );
    expect(h.command({ type: "queue.resume", threadId: id, expectedRevision: 0 })).toMatchObject(
      refused,
    );
    await h.engine.flush();
    expect(h.contexts).toEqual([]);

    // An ordinary thread still takes messages.
    const ordinary = await h.create();
    expect(h.command({ ...send, threadId: ordinary })).toMatchObject({ ok: true });
  } finally {
    await h.close();
  }
});
