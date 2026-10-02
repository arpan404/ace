import { afterEach, expect, test } from "vitest";
import { join } from "node:path";
import { constants, backup } from "node:sqlite";
import { Command } from "@ace/protocol";
import { Engine, Store } from "@ace/daemon";
import { harness, scriptFrames, start } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
function track<T extends Awaited<ReturnType<typeof harness>>>(h: T): T {
  cleanups.push(h.close);
  return h;
}

test("large active text appends keep flowing when historical chunk reads are unavailable", async () => {
  const frames = scriptFrames();
  const h = track(
    await harness(
      [
        {
          on: "send",
          frames: [
            frames.frame(start, {
              type: "item.delta",
              agent: "root",
              item: "stream",
              field: "text",
              append: "a".repeat(1024 * 1024 + 1),
            }),
          ],
        },
      ],
      frames,
    ),
  );
  const id = await h.create();
  const ctx = h.contexts[0];
  if (!ctx) throw new Error("Missing provider");
  const before = h.store.headSeq();
  h.store.atomic((db) =>
    db.setAuthorizer((action, table, column) =>
      action === constants.SQLITE_READ && table === "engine_state_appends" && column === "patch"
        ? constants.SQLITE_DENY
        : constants.SQLITE_OK,
    ),
  );
  try {
    for (const text of [" first", " second", " third"]) {
      ctx.onFrame(
        frames.frame({
          type: "item.delta",
          agent: "root",
          item: "stream",
          field: "text",
          append: text,
        }),
      );
      await h.engine.flush();
    }
  } finally {
    h.store.atomic((db) => db.setAuthorizer(null));
  }
  expect(h.errors).toEqual([]);
  expect(
    h.store
      .readEvents({ afterSeq: before, threadId: id, limit: 1000 })
      .filter((event) => event.payload.type === "item.delta")
      .map((event) => (event.payload.type === "item.delta" ? event.payload.append : "")),
  ).toEqual([" first", " second", " third"]);
  // Window budgets exclude the large item; explicit paging must still recover every byte.
  expect(h.store.readItems(id, h.store.headSeq() + 1, 1).items[0]).toMatchObject({
    parts: [{ type: "text", text: "a".repeat(1024 * 1024 + 1) + " first second third" }],
  });
});

test("shell stream summaries survive cold engine recovery and preserve output reads", async () => {
  const frames = scriptFrames();
  const h = track(
    await harness(
      [
        {
          on: "send",
          frames: [
            frames.frame(start, {
              type: "item.delta",
              agent: "root",
              item: "shell",
              field: "output",
              append: "initial",
            }),
          ],
        },
        { on: "close" },
      ],
      frames,
    ),
  );
  const id = await h.create();
  const initial = h.contexts[0];
  if (!initial) throw new Error("Missing provider");
  initial.onFrame(
    frames.frame({
      type: "item.delta",
      agent: "root",
      item: "shell",
      field: "output",
      append: " before restart",
    }),
  );
  await h.engine.flush();
  const crashPath = join(h.home, "crash.sqlite");
  await backup(
    h.store.atomic((db) => db),
    crashPath,
  );
  h.registry.register(
    {
      ...h.adapter,
      async openSession(ctx) {
        h.contexts.push(ctx);
        return h.adapter.openSession({
          ...ctx,
          onFrame: () => ctx.onFrame(frames.frame({ ...start, nativeTurnId: "resumed" })),
        });
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  const store = new Store(crashPath);
  const engine = new Engine(store, {
    registry: h.registry,
    clock: h.clock,
    onError: (error) => h.errors.push(error),
  });
  try {
    const cmd = Command.parse({
      id: "resume-shell",
      deviceId: "device",
      payload: {
        type: "thread.send",
        threadId: id,
        input: [{ type: "text", text: "next" }],
        delivery: "queue",
      },
    });
    store.recordCommand(cmd.id, cmd.deviceId, () => engine.handler.handle(cmd, store));
    await engine.flush();
    const resumed = h.contexts.at(-1);
    if (!resumed) throw new Error("Missing resumed provider");
    resumed.onFrame(
      frames.frame({
        type: "item.delta",
        agent: "root",
        item: "shell",
        field: "output",
        append: " after restart",
      }),
    );
    await engine.flush();
    resumed.onFrame(
      frames.frame({
        type: "item.upsert",
        agent: "root",
        item: "shell",
        draft: { type: "tool_call", call: { status: "succeeded" } },
      }),
    );
    await engine.flush();
    const items = store.snapshotThread(id).items;
    const shell = Object.values(items).find((item) => item.type === "tool_call");
    if (!shell || shell.type !== "tool_call" || shell.call.detail.kind !== "shell")
      throw new Error("Missing shell output");
    expect(shell.call.detail.output).toMatchObject({
      bytes: 36,
      tail: "initial before restart after restart",
      truncated: false,
    });
    const stream = shell.call.detail.output?.streamId;
    if (!stream) throw new Error("Missing stream");
    expect(Buffer.from(store.readOutput(stream, 0, 256 * 1024).bytes, "base64").toString()).toBe(
      "initial before restart after restart",
    );
    expect(h.errors).toEqual([]);
  } finally {
    await engine.close();
    store.close();
  }
});
