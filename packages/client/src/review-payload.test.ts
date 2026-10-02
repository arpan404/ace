import { afterEach, expect, test } from "vitest";
import { ItemId } from "@ace/protocol";
import { setup, ready, when, agentId } from "./test-support.ts";
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

test("a multi-megabyte shell output can be subscribed without killing the client", async () => {
  const h = await setup(); cleanup = h.cleanup; const id = ItemId.parse("large-shell");
  h.daemon.store.appendEvents(h.thread.id, [{ type: "item.created", item: { type: "tool_call", id, agentId, createdAt: 1, complete: false,
    call: { id, agentId, kind: "shell", title: "large", startedAt: 1, status: "running", raw: [],
      detail: { kind: "shell", command: "synthetic", output: "x".repeat(2 * 1024 * 1024) } } } }]);
  const { client } = h.make(); await ready(client); const { store } = client.thread(h.thread.id);
  await when(client.connectionState(), (state) => state !== "ready").catch(() => {});
  expect(client.state).toBe("ready"); expect(store.item(id)?.type).toBe("tool_call");
});
