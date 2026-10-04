import { statSync } from "node:fs";
import { harness, scriptFrames, start } from "../src/engine/test-support.ts";

const frames = scriptFrames();
const h = await harness([{ on: "send", frames: [frames.frame(start)] }], frames);
try {
  const id = await h.create();
  const ctx = h.contexts[0];
  if (!ctx) throw new Error("Missing context");
  ctx.onFrame(
    frames.frame({
      type: "item.delta",
      item: "stream",
      agent: "root",
      field: "text",
      append: "seed",
    }),
  );
  await h.engine.flush();
  h.store.statement("PRAGMA wal_autocheckpoint=0").get();
  h.store.statement("PRAGMA wal_checkpoint(TRUNCATE)").get();
  const before = statSync(h.path + "-wal").size;
  const writes = h.store.atomic((db) => Number(db.prepare("SELECT total_changes() AS n").get()?.n));
  const count = 1000;
  const acknowledgements: unknown[] = [];
  for (let i = 0; i < count; i++)
    acknowledgements.push(
      ctx.onFrame(
        frames.frame(
          { type: "signal", agent: "root" },
          {
            type: "item.delta",
            item: "stream",
            agent: "root",
            field: "text",
            append: "x",
          },
        ),
      ),
    );
  await h.engine.flush();
  await Promise.all(acknowledgements);
  const afterWrites = h.store.atomic((db) =>
    Number(db.prepare("SELECT total_changes() AS n").get()?.n),
  );
  console.log(
    JSON.stringify({
      count,
      walBytesPerDelta: (statSync(h.path + "-wal").size - before) / count,
      rowsPerDelta: (afterWrites - writes) / count,
      snapshotBytes: Buffer.byteLength(JSON.stringify(h.store.snapshotThread(id))),
      rss: process.memoryUsage().rss,
      heap: process.memoryUsage().heapUsed,
      errors: h.errors.length,
    }),
  );
} finally {
  await h.close();
}
