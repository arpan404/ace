import { afterEach, expect, test } from "vitest";
import type { QueuedMessage } from "@ace/protocol";
import { fixture, cleanupRecovery, text, sends } from "./recovery-test-support.ts";
import { scriptFrames } from "./test-support.ts";

afterEach(cleanupRecovery);

test("an input awaiting admission holds queue capacity, and stays for review after provider exit", async () => {
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
});

test("an input left uncertain by a provider exit frees its place in a full queue", async () => {
  const h = await fixture([{ on: "send" }], scriptFrames());
  const id = await h.create();
  for (let index = 1; index <= 255; index++)
    h.command(
      { type: "thread.send", threadId: id, input: text(`Follow-up ${index}`), delivery: "queue" },
      "device",
      `follow-up-${index}`,
    );
  h.contexts.at(-1)?.onExit({ deliberate: false, message: "Lost provider before admission" });
  await h.engine.flush();
  expect(h.engine.queuePage({ threadId: id, limit: 1 }).messages[0]).toMatchObject({
    state: "uncertain",
  });
  expect(
    h.command({ type: "thread.send", threadId: id, input: text("After exit"), delivery: "queue" })
      .ok,
  ).toBe(true);
  await h.engine.flush();
  // The uncertain input left the queue without being sent again; the queue went on in order.
  expect(sends(h.adapter).map((command) => command.input)).toEqual([
    text("first"),
    text("Follow-up 1"),
  ]);
  expect(h.engine.queuePage({ threadId: id, limit: 1 }).messages[0]).toMatchObject({
    id: "follow-up-2",
    state: "queued",
  });
});
