import { afterEach, expect, test } from "vitest";
import { scriptFrames, start } from "./test-support.ts";
import { cleanupRecovery, fixture, restart } from "./recovery-test-support.ts";

afterEach(cleanupRecovery);

async function workingThreads(count: number) {
  const frames = scriptFrames();
  const h = await fixture([{ on: "send", frames: [frames.frame(start)] }], frames);
  const ids = [];
  for (let index = 0; index < count; index++) ids.push(await h.create());
  await h.engine.flush();
  for (const id of ids) expect(h.store.getThread(id)?.status.state).toBe("working");
  return { h, ids };
}

test('a thread stored with the old switch recommendation "delegate_task" starts and reads back as "delegate"', async () => {
  const { h, ids } = await workingThreads(1);
  const [id] = ids;
  if (!id) throw new Error("Missing thread");
  await h.engine.close();
  const stored = {
    switch: {
      selection: { provider: "claude", options: {} },
      state: "applied",
      lossy: true,
      recommendation: "delegate_task",
      at: 1,
    },
  };
  h.store.atomic((db) =>
    db.prepare("UPDATE threads SET transitions=? WHERE id=?").run(JSON.stringify(stored), id),
  );
  await restart(h);
  expect(h.store.getThread(id)?.switch).toMatchObject({ recommendation: "delegate" });
  expect(h.store.getThread(id)?.status.state).not.toBe("working");
});

test("a thread whose stored engine state cannot be read is skipped at startup while every other thread recovers", async () => {
  const { h, ids } = await workingThreads(2);
  const [broken, healthy] = ids;
  if (!broken || !healthy) throw new Error("Missing threads");
  // Stop the old engine first: shutdown saves every thread's state once more.
  await h.engine.close();
  h.store.atomic((db) =>
    db.prepare("UPDATE thread_state SET state=? WHERE thread_id=?").run('{"unreadable":1}', broken),
  );
  const errors: unknown[] = [];
  await restart(h, { onError: (error) => errors.push(error) });
  // The healthy thread went through restart recovery: its interrupted turn no longer runs.
  expect(h.store.getThread(healthy)?.status.state).not.toBe("working");
  expect(errors).toContainEqual(
    expect.objectContaining({
      message: `Thread ${broken} was skipped at startup: its stored state could not be read`,
    }),
  );
});
