import { afterEach, expect, test } from "vitest";
import { setup, ready, barrier } from "./test-support.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

for (const completion of ["resolves", "rejects"] as const) {
  test(`abort releases a pending recording and suppresses dispatch when it later ${completion}`, async () => {
    const h = await setup();
    cleanup = h.cleanup;
    const { client } = h.make({ limits: { intents: 1 } });
    await ready(client);
    const payload = { type: "thread.archive", threadId: h.thread.id } as const;
    const recordings: ReturnType<typeof Promise.withResolvers<void>>[] = [];
    let lastId = "";
    // Each cancelled callback remains pending, exceeding the admission budget if ownership leaks.
    for (let index = 0; index < 3; index++) {
      const gate = Promise.withResolvers<void>();
      recordings.push(gate);
      const controller = new AbortController();
      const submission = client.submitNew(
        payload,
        (id) => {
          lastId = id;
          return gate.promise;
        },
        { signal: controller.signal },
      );
      const refused = expect(submission).rejects.toMatchObject({ code: "not_dispatched" });
      controller.abort();
      await refused;
      expect(client.intent(lastId).getSnapshot()).toBeUndefined();
    }
    expect(
      await client.command(
        { type: "thread.rename", threadId: h.thread.id, title: "Retried cancelled recording" },
        {},
        lastId,
      ),
    ).toMatchObject({ ok: true, commandId: lastId });
    for (const gate of recordings) {
      if (completion === "resolves") gate.resolve();
      else gate.reject(new Error("Late recording failure"));
    }
    await barrier(client, h.thread.id);
    expect(h.daemon.store.getThread(h.thread.id)?.title).toBe("Retried cancelled recording");
    expect(h.daemon.store.getThread(h.thread.id)?.archivedAt).toBeUndefined();
  });
}

test("client close settles pending recording without waiting for its callback and a late completion cannot dispatch", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const { client } = h.make();
  await ready(client);
  const gate = Promise.withResolvers<void>();
  let id = "";
  const submission = client.submitNew(
    { type: "thread.archive", threadId: h.thread.id },
    (allocated) => {
      id = allocated;
      return gate.promise;
    },
  );
  const refused = expect(submission).rejects.toMatchObject({ code: "not_dispatched" });
  await client.close();
  await refused;
  expect(client.intent(id).getSnapshot()).toBeUndefined();
  const replacement = h.make().client;
  await ready(replacement);
  expect(
    await replacement.command(
      { type: "thread.rename", threadId: h.thread.id, title: "Replacement client" },
      {},
      id,
    ),
  ).toMatchObject({ ok: true });
  gate.resolve();
  await barrier(replacement, h.thread.id);
  expect(h.daemon.store.getThread(h.thread.id)?.archivedAt).toBeUndefined();
  expect(h.daemon.store.getThread(h.thread.id)?.title).toBe("Replacement client");
});

test("abort after admission begins keeps the ID reserved until persistence settles", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const saving = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { client, faults } = h.make({
    storage: {
      load: async () => null,
      async save() {
        saving.resolve();
        await release.promise;
      },
    },
  });
  await ready(client);
  const controller = new AbortController();
  let id = "";
  const payload = { type: "thread.archive", threadId: h.thread.id } as const;
  const submission = client.submitNew(
    payload,
    (allocated) => {
      id = allocated;
    },
    {
      signal: controller.signal,
    },
  );
  const aborted = expect(submission).rejects.toMatchObject({ code: "aborted" });
  await saving.promise;
  controller.abort();
  await aborted;
  try {
    await expect(client.command(payload, {}, id)).rejects.toMatchObject({ code: "limit" });
    await expect(client.enqueue(payload, id)).rejects.toMatchObject({ code: "limit" });
    expect(h.daemon.store.getThread(h.thread.id)?.archivedAt).toBeUndefined();
  } finally {
    release.resolve();
  }
  await faults.wait((message) => message.type === "commandResult" && message.commandId === id);
  expect(await client.command(payload, {}, id)).toMatchObject({ ok: true });
  expect(h.daemon.store.getThread(h.thread.id)?.archivedAt).toBeDefined();
});
