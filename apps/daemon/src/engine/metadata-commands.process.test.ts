import { afterEach, expect, test } from "vitest";
import { Thread, ThreadId } from "@ace/protocol";
import { harness, scriptFrames } from "./test-support.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

test.each([false, true])(
  "persisted metadata-only threads archive exactly once (imported=%s)",
  async (imported) => {
    const h = await harness([], scriptFrames());
    cleanup = h.close;
    const thread = Thread.parse({
      id: "stored",
      workspaceId: h.workspace,
      title: "Saved",
      provider: "codex",
      status: { state: "done" },
      createdAt: 1,
      updatedAt: 1,
      ...(imported
        ? {
            imported: {
              sourceId: "source",
              instanceId: "instance",
              native: { provider: "codex", nativeId: "native" },
              importedAt: 1,
            },
          }
        : {}),
    });
    h.store.appendEvents(thread.id, [{ type: "thread.created", thread }], 1);
    const payload = { type: "thread.archive" as const, threadId: thread.id };
    const result = h.command(payload, "device", "archive");
    expect(result).toMatchObject({ ok: true });
    expect(h.command(payload, "device", "archive")).toEqual(result);
    expect(h.store.getThread(thread.id)?.archivedAt).toBe(h.clock.time);
    expect(
      h.store
        .readEvents({ afterSeq: 0, threadId: thread.id, limit: 100 })
        .filter((event) => event.payload.type === "thread.updated"),
    ).toHaveLength(1);
    expect(
      h.command({ type: "thread.archive", threadId: ThreadId.parse("missing") }),
    ).toMatchObject({ ok: false, error: "thread_not_found" });
    await h.engine.flush();
    expect(h.contexts).toEqual([]);
  },
);

test("unsupported service commands never start provider work", async () => {
  const h = await harness([], scriptFrames());
  cleanup = h.close;
  expect(h.command({ type: "orchestration.cancel", orchestrationId: "missing" })).toMatchObject({
    ok: false,
    error: "not_implemented",
  });
  await h.engine.flush();
  expect(h.store.listThreads()).toEqual([]);
  expect(h.contexts).toEqual([]);
  expect(h.errors).toEqual([]);
});
