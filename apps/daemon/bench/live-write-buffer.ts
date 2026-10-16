/** Deterministic provider, real SQLite and subscriptions; never starts a provider CLI. */
import { performance } from "node:perf_hooks";
import { harness, scriptFrames, start } from "../src/engine/test-support.ts";

const frames = scriptFrames();
const h = await harness(
  [
    {
      on: "send",
      frames: [
        frames.frame(start, {
          type: "item.upsert",
          agent: "root",
          item: "answer",
          draft: { type: "message", role: "assistant", parts: [{ type: "text", text: "" }] },
        }),
      ],
    },
  ],
  frames,
);
try {
  const id = await h.create();
  const context = h.contexts[0];
  if (!context) throw new Error("Missing scripted session");
  let delivered = 0;
  const stop = h.store.subscribe((events) => {
    delivered += events.filter((event) => event.payload.type === "item.delta").length;
  });
  const before = h.store.streamingMetrics();
  const began = performance.now();
  for (let index = 0; index < 1000; index++)
    await context.onFrame(
      frames.frame({
        type: "item.delta",
        agent: "root",
        item: "answer",
        field: "text",
        append: "token ",
      }),
    );
  await h.engine.flush();
  const elapsedMs = performance.now() - began;
  const after = h.store.streamingMetrics();
  stop();
  const items = h.store.readItems(id, h.store.headSeq() + 1, 10).items;
  const answer = items.at(-1);
  if (
    delivered !== 1000 ||
    answer?.type !== "message" ||
    answer.parts[0]?.type !== "text" ||
    answer.parts[0].text !== "token ".repeat(1000)
  )
    throw new Error("Streaming output diverged");
  console.log(
    JSON.stringify(
      {
        tokens: 1000,
        delivered,
        elapsedMs,
        transactions: after.transactions - before.transactions,
        deltaRows: after.rows - before.rows,
        peakBufferedBytes: after.peakBytes,
        walBytes: after.walBytes,
      },
      null,
      2,
    ),
  );
} finally {
  await h.close();
}
