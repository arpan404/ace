import { defaultLimits, ThreadStore } from "@ace/client";
import { createThreadView } from "@ace/projection";
import { Event, Thread } from "@ace/protocol";
import { expect, test } from "vitest";
import { createBlockReader } from "./transcript-block-reader.ts";

/*
 * A Spade bot's reply posted in a thread (ADR 0198) is its own row: never folded into the
 * agent's turn, and never taken for the turn's answer, even when it comes after the answer.
 */

const thread = Thread.parse({
  id: "thread",
  workspaceId: "workspace",
  provider: "codex",
  title: "Fix login",
  rootAgentId: "root",
  status: { state: "done" },
  createdAt: 0,
  updatedAt: 0,
});

function transcript() {
  const store = new ThreadStore(defaultLimits);
  store.snapshot(createThreadView(thread));
  let seq = 0;
  const admit = (...payloads: unknown[]) => {
    for (const payload of payloads) {
      seq++;
      store.delivery({
        type: "events",
        subscriptionId: "s",
        afterSeq: seq - 1,
        throughSeq: seq,
        events: [Event.parse({ id: `e${seq}`, seq, at: seq, threadId: thread.id, payload })],
      });
    }
  };
  admit({
    type: "agent.created",
    agent: {
      id: "root",
      threadId: thread.id,
      parentId: null,
      origin: "root",
      native: { provider: "codex", nativeId: "root" },
      fidelity: "full",
      cwd: "/repo",
      status: { state: "idle" },
      createdAt: 0,
    },
  });
  const read = createBlockReader();
  return { admit, blocks: () => read(store).value };
}

const item = (fields: Record<string, unknown>) => ({
  type: "item.created",
  item: { agentId: "root", createdAt: 1, complete: true, raw: [], ...fields },
});

test("a bot's reply after the agent's answer is its own row, and the agent's answer stays the answer", () => {
  const { admit, blocks } = transcript();
  admit(
    {
      type: "run.started",
      run: {
        id: "run",
        threadId: "thread",
        agentId: "root",
        trigger: "user",
        state: "active",
        startedAt: 1,
        turn: 1,
      },
    },
    item({
      id: "ask",
      type: "message",
      role: "user",
      parts: [{ type: "text", text: "@Research why does login fail?" }],
      origin: { kind: "person", commandId: "send-1" },
    }),
    item({
      id: "answer",
      runId: "run",
      type: "message",
      role: "assistant",
      parts: [{ type: "text", text: "Fixed." }],
    }),
    { type: "run.ended", runId: "run", state: "completed", endedAt: 5 },
    item({
      id: "bot",
      type: "message",
      role: "assistant",
      parts: [{ type: "text", text: "The cookie expired." }],
      speaker: { kind: "bot", id: "research", name: "Research", about: "send-1" },
    }),
  );
  const shown = blocks();
  expect(shown.find((block) => "itemId" in block && block.itemId === "bot")?.kind).toBe("item");
  expect(shown.find((block) => "itemId" in block && block.itemId === "answer")?.kind).toBe(
    "message",
  );
});
