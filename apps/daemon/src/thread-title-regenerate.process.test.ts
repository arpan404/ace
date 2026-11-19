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
  let titles: ThreadTitles | undefined;
  let asked = 0;
  const f = await fixture({}, (store) => {
    titles = new ThreadTitles({
      store,
      generate: () => {
        asked++;
        return reply();
      },
      now: () => 2000,
    });
    return { utility: { titles } };
  });
  if (!titles) throw new Error("The fixture made no title generator");
  const generator = titles;
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
  let taps = 0;
  const regenerate = async (threadId: string = f.thread.id) => {
    client.send({
      type: "command",
      command: Command.parse({
        id: `regenerate-${threadId}-${++taps}`,
        deviceId: DeviceId.parse("device"),
        payload: { type: "thread.title.regenerate", threadId: ThreadId.parse(threadId) },
      }),
    });
    return client.next();
  };
  return {
    ...f,
    regenerate,
    /** Resolves once every title being generated has landed or been given up on. */
    generated: () => generator.regenerated(),
    asked: () => asked,
  };
}

test("a renamed thread named again takes its opening request's words, then the model's title", async () => {
  const f = await setup(async () => "Delay the reconnect banner");
  expect(await f.regenerate()).toMatchObject({ type: "commandResult", ok: true });
  await f.generated();
  expect(f.store.getThread(f.thread.id)).toMatchObject({
    title: "Delay the reconnect banner",
    titleSource: "generated",
  });
});

test("with no utility model the thread keeps its opening request's words as its title", async () => {
  const f = await setup(() => Promise.reject(new Error("utility_unavailable")));
  expect(await f.regenerate()).toMatchObject({ ok: true });
  await f.generated();
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
  await f.generated();
  expect(f.store.getThread(f.thread.id)?.title).toBe("Picked by hand");
});

test("tapping New title again while one is generating asks the model once", async () => {
  const pending = Promise.withResolvers<string>();
  const f = await setup(() => pending.promise);
  await f.regenerate();
  await f.regenerate();
  pending.resolve("Delay the reconnect banner");
  await f.generated();
  expect(f.asked()).toBe(1);
  expect(f.store.getThread(f.thread.id)?.title).toBe("Delay the reconnect banner");
});
