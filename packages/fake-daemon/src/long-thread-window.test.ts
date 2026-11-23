import { expect, test } from "vitest";
import { Item, ThreadId, WorkspaceId } from "@ace/protocol";
import { FakeLongThreadWire } from "./long-thread-wire.ts";
import { ThreadHost } from "./thread-host.ts";

test("reading an older page seeks by sequence without scanning the earlier history", () => {
  const work = (history: number) => {
    const id = ThreadId.parse("history");
    const host = new ThreadHost({
      id,
      workspaceId: WorkspaceId.parse("ace"),
      title: "History",
      provider: "codex",
      status: { state: "new" },
      createdAt: 0,
      updatedAt: 0,
    });
    for (let seq = 1; seq <= history; seq++) {
      const item = Item.parse({
        id: `i-${seq}`,
        agentId: "root",
        type: "message",
        role: "assistant",
        createdAt: seq,
        complete: true,
        parts: [{ type: "text", text: `History ${seq}` }],
      });
      host.view.items[item.id] = item;
      host.view.itemOrder.push(item.id);
      host.creation.set(item.id, seq);
    }
    let reads = 0;
    const order = host.view.itemOrder;
    host.view.itemOrder = new Proxy(order, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, receiver);
      },
    });
    const wire = new FakeLongThreadWire({
      head: () => history,
      thread: () => host,
      output: () => "",
      now: () => 0,
    });
    const cursor = history - 200;
    wire.handle(
      {
        type: "items.window",
        requestId: "page",
        threadId: id,
        aroundSeq: cursor,
        before: 200,
        after: 0,
        wholeTurns: true,
      },
      "phone",
      (page) => {
        expect(page).toMatchObject({
          type: "items.window",
          targetSeq: cursor,
          itemsBefore: cursor - 200,
          itemsAfter: cursor,
        });
        if (page.type === "items.window") {
          expect(page.items.map((item) => item.id)).toEqual(
            Array.from({ length: 201 }, (_, index) => `i-${cursor - 200 + index}`),
          );
        }
      },
    );
    return reads;
  };
  expect.assertions(6);
  const short = work(800);
  const long = work(8_000);
  console.info(`history page order reads: ${short} at 800 items, ${long} at 8,000 items`);
  expect(short).toBeLessThan(230);
  expect(long).toBeLessThan(230);
});
