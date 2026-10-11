import { ItemId } from "@ace/protocol";
import { createDevThread } from "./commands.ts";
import { expect, it } from "vitest";
import { agentMessage, storeFixture } from "./long-thread-test-support.ts";

it("exact item windows survive restart and never substitute a nearby item for an unknown target", async () => {
  const f = storeFixture();
  f.store.appendEvents(
    f.thread.id,
    [
      { type: "item.created", item: agentMessage("older", "Earlier finding") },
      { type: "item.created", item: agentMessage("requested", "Requested finding") },
      { type: "item.created", item: agentMessage("newer", "Latest finding") },
    ],
    20,
  );
  await f.restart();
  const requested = f.store.itemsWindow({
    threadId: f.thread.id,
    itemId: ItemId.parse("requested"),
    before: 0,
    after: 0,
  });
  expect(requested.items.map((item) => item.id)).toEqual(["requested"]);
  const missing = f.store.itemsWindow({
    threadId: f.thread.id,
    itemId: ItemId.parse("deleted"),
    before: 1,
    after: 1,
  });
  expect(missing.targetSeq).toBeNull();
  expect(missing.items).toEqual([]);
  const other = createDevThread(f.store, f.workspace);
  expect(
    f.store.itemsWindow({
      threadId: other.id,
      itemId: ItemId.parse("requested"),
      before: 0,
      after: 0,
    }).targetSeq,
  ).toBeNull();
});
