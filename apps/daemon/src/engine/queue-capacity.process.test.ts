import { afterEach, expect, test } from "vitest";
import type { QueuedMessage } from "@ace/protocol";
import { fixture, cleanupRecovery, text, sends } from "./recovery-test-support.ts";
import { scriptFrames } from "./test-support.ts";

afterEach(cleanupRecovery);

test("an input awaiting admission retains capacity after send returns and after provider exit", async () => {
  const h = await fixture([{ on: "send" }], scriptFrames());
  const id = await h.create();
  expect(sends(h.adapter).map((command) => command.input)).toEqual([text("first")]);
  for (let index = 1; index <= 255; index++)
    expect(
      h.command(
        { type: "thread.send", threadId: id, input: text(`Follow-up ${index}`), delivery: "queue" },
        "device",
        `follow-up-${index}`,
      ).ok,
    ).toBe(true);
  expect(
    h.command({ type: "thread.send", threadId: id, input: text("Overflow"), delivery: "queue" })
      .error,
  ).toBe("queue_capacity_exceeded");
  await h.engine.flush();
  expect(sends(h.adapter)).toHaveLength(1);
  h.contexts.at(-1)?.onExit({ deliberate: false, message: "Lost provider before admission" });
  await h.engine.flush();
  expect(h.engine.queue(id)).toMatchObject({ paused: true, pendingCount: 256 });
  const retained: QueuedMessage[] = [];
  let page = h.engine.queuePage({ threadId: id, limit: 32 });
  const revision = page.revision;
  for (;;) {
    retained.push(...page.messages);
    if (page.next === null) break;
    page = h.engine.queuePage({
      threadId: id,
      limit: 32,
      after: page.next,
      expectedRevision: revision,
    });
  }
  expect(retained).toHaveLength(256);
  expect(retained[0]).toMatchObject({ input: text("first"), state: "uncertain" });
  expect(retained.at(-1)).toMatchObject({ id: "follow-up-255", input: text("Follow-up 255") });
  expect(
    h.command({ type: "thread.send", threadId: id, input: text("Still full"), delivery: "queue" })
      .error,
  ).toBe("queue_capacity_exceeded");
});
