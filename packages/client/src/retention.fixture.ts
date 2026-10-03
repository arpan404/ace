import { strict as assert } from "node:assert";
import { setImmediate } from "node:timers/promises";
import { Item } from "@ace/protocol";
import { setup, ready, agentId, itemId } from "./test-support.ts";
const h = await setup();
try {
  const item = Item.parse({
    type: "tool_call",
    id: itemId,
    agentId,
    createdAt: 0,
    complete: true,
    call: {
      id: itemId,
      agentId,
      kind: "shell",
      title: "retention",
      startedAt: 0,
      status: "succeeded",
      raw: [],
      detail: { kind: "shell", command: "synthetic" },
    },
  });
  h.daemon.store.appendEvents(h.thread.id, [
    { type: "item.created", item },
    { type: "item.delta", itemId, agentId, field: "output", append: "x".repeat(8 * 1024 * 1024) },
  ]);
  const { client } = h.make();
  await ready(client);
  const stream = client.output({ streamId: `output:${itemId}`, offset: 0, limit: 256 * 1024 });
  let first = await stream.next();
  if (!first.value) throw new Error("first chunk");
  const reference = new WeakRef(first.value);
  first = { done: true, value: undefined };
  for (let index = 0; index < 16; index++) {
    const next = await stream.next();
    assert.equal(next.value?.byteLength, 256 * 1024);
  }
  // A macrotask boundary ends WeakRef's keep-alive job. Explicit GC is a controllable
  // memory edge, not a timing or RSS threshold. Only this child gets --expose-gc.
  await setImmediate();
  if (!globalThis.gc) throw new Error("explicit GC required");
  globalThis.gc();
  assert.equal(reference.deref(), undefined, "consumed output chunks must be released");
  await stream.return(undefined);
} finally {
  await h.cleanup();
}
