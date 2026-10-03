import { afterEach, expect, test } from "vitest";
import { ItemId } from "@ace/protocol";
import { setup, ready, when, agentId } from "./test-support.ts";
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

test("a multi-megabyte shell output can be subscribed without killing the client", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const id = ItemId.parse("large-shell");
  h.daemon.store.appendEvents(h.thread.id, [
    {
      type: "item.created",
      item: {
        type: "tool_call",
        id,
        agentId,
        createdAt: 1,
        complete: false,
        call: {
          id,
          agentId,
          kind: "shell",
          title: "large",
          startedAt: 1,
          status: "running",
          raw: [],
          detail: { kind: "shell", command: "synthetic" },
        },
      },
    },
  ]);
  h.daemon.store.appendEvents(h.thread.id, [
    {
      type: "item.delta",
      itemId: id,
      agentId,
      field: "output",
      append: "x".repeat(2 * 1024 * 1024),
    },
  ]);
  const { client } = h.make();
  await ready(client);
  const { store } = client.thread(h.thread.id);
  await when(
    store.select([`item:${id}`], (s) => s.item(id)),
    Boolean,
  );
  expect(client.state).toBe("ready");
  expect(store.item(id)).toMatchObject({
    call: { detail: { output: { bytes: 2 * 1024 * 1024, truncated: true } } },
  });
  const chunk = await client.outputRead({ streamId: `output:${id}`, offset: 0, limit: 256 * 1024 });
  expect(chunk.bytes).toHaveLength(256 * 1024);
  expect(chunk.bytes[0]).toBe(120);
  expect(chunk.eof).toBe(false);
});
