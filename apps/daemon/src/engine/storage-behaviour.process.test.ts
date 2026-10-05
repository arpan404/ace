import { afterEach, expect, test } from "vitest";
import { Engine, Store } from "@ace/daemon";
import { z } from "zod";
import { Command } from "@ace/protocol";
import type { Fact } from "@ace/core";
import { harness, scriptFrames, start, end } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const input = [{ type: "text" as const, text: "next" }];
function track<T extends Awaited<ReturnType<typeof harness>>>(h: T): T {
  cleanups.push(h.close);
  return h;
}
function view(store: Store, id: Parameters<Store["snapshotThread"]>[0]) {
  const result = store.snapshotThread(id);
  return result;
}

const tool = (item: string, title: string): Fact => ({
  type: "item.upsert",
  agent: "root",
  item,
  draft: {
    type: "tool_call",
    call: { kind: "shell", title, status: "running", detail: { kind: "shell", command: title } },
  },
});

test("delta frames only change their snapshot record and recover text beyond the hot cache", async () => {
  const frames = scriptFrames();
  const h = track(
    await harness([{ on: "send", frames: [frames.frame(start)] }, { on: "send" }], frames),
  );
  const id = await h.create();
  const ctx = h.contexts[0];
  if (!ctx) throw new Error("Missing provider");
  const facts: Fact[] = [];
  for (let i = 0; i < 300; i++)
    facts.push({
      type: "item.upsert",
      agent: "root",
      item: `history:${i}`,
      draft: {
        type: "message",
        role: "assistant",
        parts: [{ type: "text", text: `history ${i}` }],
        complete: true,
      },
    });
  ctx.onFrame(frames.frame(...facts));
  await h.engine.flush();
  h.store.atomic((db) =>
    db.exec(
      `CREATE TRIGGER forbid_history_rewrite BEFORE UPDATE ON engine_state_records WHEN NEW.section='items' BEGIN SELECT RAISE(ABORT,'history rewritten'); END`,
    ),
  );
  for (const text of [" first", " second", " third"]) {
    ctx.onFrame(
      frames.frame({
        type: "item.delta",
        agent: "root",
        item: "history:0",
        field: "text",
        append: text,
      }),
    );
    await h.engine.flush();
  }
  expect(h.errors).toEqual([]);
  const restarted = new Store(h.path);
  const engine = new Engine(restarted, { registry: h.registry, clock: h.clock });
  try {
    await engine.flush();
    // Resume, access a cold historical item, and append through the same public frame path.
    h.store.atomic((db) => db.exec("DROP TRIGGER forbid_history_rewrite"));
    const command = {
      id: "resume-cold",
      deviceId: "device",
      payload: {
        type: "thread.resume" as const,
        threadId: id,
        expectedRevision: engine.queue(id).revision,
      },
    };
    const parsed = Command.parse(command);
    restarted.recordCommand(parsed.id, parsed.deviceId, () =>
      engine.handler.handle(parsed, restarted),
    );
    await engine.flush();
    const resumed = h.contexts.at(-1);
    if (!resumed) throw new Error("Missing resumed provider");
    resumed.onFrame(
      frames.frame({
        type: "item.delta",
        agent: "root",
        item: "history:0",
        field: "text",
        append: " recovered",
      }),
    );
    await engine.flush();
    resumed.onFrame(
      frames.frame({
        type: "item.upsert",
        agent: "root",
        item: "history:0",
        draft: { type: "message", complete: true },
      }),
    );
    await engine.flush();
    expect(
      restarted
        .readItems(id, restarted.readItems(id, restarted.headSeq() + 1, 200).itemsBefore ?? 1, 200)
        .items.some(
          (item) =>
            item.type === "message" &&
            item.parts.some(
              (part) =>
                part.type === "text" && part.text === "history 0 first second third recovered",
            ),
        ),
    ).toBe(true);
  } finally {
    await engine.close();
    restarted.close();
  }
});

test("a rejected incremental snapshot append cannot commit its delta event or change recovery", async () => {
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
              item: "answer",
              field: "text",
              append: "saved",
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
  const seq = h.store.headSeq();
  h.store.atomic((db) =>
    db.exec(
      `CREATE TRIGGER reject_append BEFORE INSERT ON engine_state_appends BEGIN SELECT RAISE(ABORT,'append failure'); END`,
    ),
  );
  ctx.onFrame(
    frames.frame({
      type: "item.delta",
      agent: "root",
      item: "answer",
      field: "text",
      append: " lost",
    }),
  );
  await h.engine.flush();
  const deltas = h.store
    .readEvents({ afterSeq: seq, threadId: id, limit: 1000 })
    .filter((event) => event.payload.type === "item.delta");
  expect(deltas).toEqual([]);
  expect(
    Object.values(view(h.store, id).items).find(
      (item) => item.type === "message" && item.role === "assistant",
    ),
  ).toMatchObject({ parts: [{ type: "text", text: "saved" }] });
  expect(
    h.errors.some((error) => error instanceof Error && error.message.includes("append failure")),
  ).toBe(true);
});

test("a partial end-only native turn stays completed across cold snapshot recovery", async () => {
  const frames = scriptFrames();
  const h = track(
    await harness(
      [{ on: "send", frames: [frames.frame({ ...end, nativeTurnId: "partial" })] }],
      frames,
    ),
  );
  const id = await h.create();
  const store = new Store(h.path);
  const engine = new Engine(store, { registry: h.registry, clock: h.clock });
  try {
    await engine.flush();
    expect(Object.values(view(store, id).runs).map((run) => run.state)).toEqual(["completed"]);
    expect(store.getThread(id)?.status.state).toBe("done");
  } finally {
    await engine.close();
    store.close();
  }
});

test.each(["item.upsert", "item.reconciled"] as const)(
  "oversized unknown raw data from %s is capped in snapshots and events while its original JSON is readable",
  async (type) => {
    const frames = scriptFrames();
    const data = { unfamiliar: "x".repeat(1024 * 1024), nested: { survives: true } };
    const h = track(
      await harness(
        [
          {
            on: "send",
            frames: [
              frames.frame(
                start,
                {
                  type,
                  agent: "root",
                  item: "raw",
                  draft: {
                    type: "notice",
                    level: "info",
                    text: "unknown provider event",
                    raw: [{ type: "unfamiliar", data }],
                  },
                },
                end,
              ),
            ],
          },
        ],
        frames,
      ),
    );
    const id = await h.create();
    const notice = Object.values(view(h.store, id).items).find((item) => item.type === "notice");
    if (!notice || notice.type !== "notice") throw new Error("Missing raw notice");
    const blob = z
      .object({ blobRef: z.string(), size: z.number(), preview: z.string() })
      .parse(notice.raw[0]);
    expect(blob.size).toBeGreaterThan(1024 * 1024);
    const bytes = h.engine.readRawBlob(blob.blobRef);
    expect(bytes).toBeDefined();
    expect(JSON.parse(Buffer.from(bytes ?? []).toString())).toEqual(data);
    const snapshotBytes = h.store.atomic((db) =>
      Number(
        db
          .prepare("SELECT sum(length(CAST(value AS BLOB))) AS bytes FROM engine_state_records")
          .get()?.bytes,
      ),
    );
    expect(snapshotBytes).toBeLessThan(64 * 1024);
    expect(
      JSON.stringify(h.store.readEvents({ afterSeq: 0, threadId: id, limit: 1000 })).length,
    ).toBeLessThan(64 * 1024);
  },
);

test("a recovered message can append a new text part whose saved base had none", async () => {
  const frames = scriptFrames();
  const h = track(
    await harness(
      [
        {
          on: "send",
          frames: [
            frames.frame(start, {
              type: "item.upsert",
              agent: "root",
              item: "empty",
              draft: { type: "message", role: "assistant", parts: [] },
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
  ctx.onFrame(
    frames.frame({
      type: "item.delta",
      agent: "root",
      item: "empty",
      field: "text",
      append: "restored part",
    }),
  );
  await h.engine.flush();
  h.registry.register(
    {
      ...h.adapter,
      async openSession(context) {
        h.contexts.push(context);
        return h.adapter.openSession({
          ...context,
          onFrame: () => context.onFrame(frames.frame(start)),
        });
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  const store = new Store(h.path);
  const engine = new Engine(store, { registry: h.registry, clock: h.clock });
  try {
    await engine.flush();
    const parsed = Command.parse({
      id: "resume-empty",
      deviceId: "device",
      payload: { type: "thread.send", threadId: id, input, delivery: "queue" },
    });
    store.recordCommand(parsed.id, parsed.deviceId, () => engine.handler.handle(parsed, store));
    await engine.flush();
    const resumed = h.contexts.at(-1);
    if (!resumed) throw new Error("Missing resumed provider");
    resumed.onFrame(
      frames.frame({
        type: "item.upsert",
        agent: "root",
        item: "empty",
        draft: { type: "message", complete: true },
      }),
    );
    await engine.flush();
    expect(
      Object.values(view(store, id).items).find(
        (item) => item.type === "message" && item.role === "assistant",
      ),
    ).toMatchObject({ parts: [{ type: "text", text: "restored part" }] });
  } finally {
    await engine.close();
    store.close();
  }
});

test("persisted tool ordering keeps the latest same-frame tool selected on subsequent facts", async () => {
  const frames = scriptFrames();

  const h = track(
    await harness(
      [
        {
          on: "send",
          frames: [frames.frame(start, tool("zeta", "First"), tool("alpha", "Latest"))],
        },
      ],
      frames,
    ),
  );
  const id = await h.create();
  const firstView = view(h.store, id);
  const latestId = Object.values(firstView.items).find(
    (item) => item.type === "tool_call" && item.call.title === "Latest",
  )?.id;
  if (!latestId) throw new Error("Missing latest tool");
  const ctx = h.contexts[0];
  if (!ctx) throw new Error("Missing provider");
  ctx.onFrame(frames.frame({ type: "tick" }));
  await h.engine.flush();
  expect(Object.values(view(h.store, id).agents)[0]?.status).toMatchObject({
    state: "working",
    activity: "tool",
    itemId: latestId,
  });
});
