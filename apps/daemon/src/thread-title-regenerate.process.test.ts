import { afterEach, expect, test } from "vitest";
import { Command, DeviceId, Item, ThreadId } from "@ace/protocol";
import { fixture } from "./socket-test-support.ts";
import { ThreadTitles } from "./thread-titles.ts";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

/** A fixture whose utility model answers `reply` (or never answers) for every title prompt. */
async function setup(reply: () => Promise<string>) {
  const f = await fixture({}, (store) => ({
    utility: { titles: new ThreadTitles({ store, generate: reply, now: () => 2000 }) },
  }));
  close = f.close;
  const client = await f.connect();
  await client.next();
  f.store.appendEvents(f.thread.id, [
    {
      type: "item.created",
      item: Item.parse({
        id: "opening",
        agentId: "root",
        createdAt: 1,
        complete: true,
        type: "message",
        role: "user",
        parts: [{ type: "text", text: "Make the reconnect banner wait before it shows" }],
      }),
    },
  ]);
  f.store.appendEvents(f.thread.id, [
    { type: "thread.updated", title: "My own name", titleSource: "person" },
  ]);
  const regenerate = async (threadId: string = f.thread.id) => {
    client.send({
      type: "command",
      command: Command.parse({
        id: `regenerate-${threadId}`,
        deviceId: DeviceId.parse("device"),
        payload: { type: "thread.title.regenerate", threadId: ThreadId.parse(threadId) },
      }),
    });
    return client.next();
  };
  return { ...f, regenerate };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

test("a renamed thread named again takes its opening request's words, then the model's title", async () => {
  const f = await setup(async () => "Delay the reconnect banner");
  expect(await f.regenerate()).toMatchObject({ type: "commandResult", ok: true });
  await settled();
  expect(f.store.getThread(f.thread.id)).toMatchObject({
    title: "Delay the reconnect banner",
    titleSource: "generated",
  });
});

test("with no utility model the thread keeps its opening request's words as its title", async () => {
  const f = await setup(() => Promise.reject(new Error("utility_unavailable")));
  expect(await f.regenerate()).toMatchObject({ ok: true });
  await settled();
  const thread = f.store.getThread(f.thread.id);
  expect(thread?.titleSource).toBe("provisional");
  expect(thread?.title).toContain("reconnect banner");
});

test("a name the person gives while the title is generating wins over the generated one", async () => {
  const pending = Promise.withResolvers<string>();
  const f = await setup(() => pending.promise);
  await f.regenerate();
  f.store.appendEvents(f.thread.id, [
    { type: "thread.updated", title: "Picked by hand", titleSource: "person" },
  ]);
  pending.resolve("Delay the reconnect banner");
  await settled();
  expect(f.store.getThread(f.thread.id)?.title).toBe("Picked by hand");
});
