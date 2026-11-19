import { describe, expect, it } from "vitest";
import {
  AgentId,
  CommandId,
  QueueSnapshot,
  ThreadId,
  type CommandPayload,
  type MessageContext,
} from "@ace/protocol";
import { queueControl, type QueueService } from "./queue-control.ts";

const thread = ThreadId.parse("thread-1");
const shot = "a".repeat(64);
const notes = "b".repeat(64);

/** An agent edits the one queued message; returns the queue command it ran. */
function edit(text: string, context: MessageContext): CommandPayload | undefined {
  let sent: CommandPayload | undefined;
  const service: QueueService = {
    queue: () =>
      QueueSnapshot.parse({
        threadId: thread,
        revision: 3,
        paused: false,
        reason: null,
        resumeAt: null,
        messages: [
          {
            id: "queued-1",
            input: [{ type: "text", text: "look here" }],
            context,
            delivery: "queue",
            state: "queued",
          },
        ],
      }),
    command(id, payload) {
      sent = payload;
      return { commandId: CommandId.parse(id), ok: true };
    },
  };
  const result = queueControl(
    service,
    { sessionId: "s", threadId: thread, agentId: AgentId.parse("agent-1") },
    { op: "queue.edit", threadId: thread, requestId: "r1", entryId: "queued-1", text },
  );
  expect(result).toEqual({ ok: true });
  return sent;
}

describe("an agent editing a queued message", () => {
  const context: MessageContext = {
    mentions: [],
    attachments: [{ sha256: shot, at: 5 }, { sha256: notes }],
  };

  it("sends the files after new text, since their spots described the old text", () => {
    const sent = edit("something else entirely", context);
    expect(sent).toMatchObject({
      type: "queue.edit",
      input: [{ type: "text", text: "something else entirely" }],
      context: { attachments: [{ sha256: shot }, { sha256: notes }] },
    });
    expect(sent?.type === "queue.edit" && sent.context?.attachments[0]).toEqual({ sha256: shot });
  });

  it("keeps each file's spot when the text is unchanged", () => {
    const sent = edit("look here", context);
    expect(sent?.type === "queue.edit" && sent.context?.attachments).toEqual(context.attachments);
  });
});
