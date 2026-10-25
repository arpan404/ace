/**
 * Daemon CPU per provider frame: replays a recorded Claude turn through the real translator,
 * engine and SQLite store, never a provider CLI. Recorded pacing runs on a manual clock, and the
 * live write buffer's timers follow it, so batching sees the gaps a real turn has.
 *
 * node bench/claude-replay.ts [fixture.jsonl] [--turns N] [--rounds N] [--burst]
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createTranslator } from "@ace/adapter-claude";
import type { Frame } from "@ace/engine-api";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { z } from "zod";
import { harness, ManualClock, scriptFrames } from "../src/engine/test-support.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    turns: { type: "string", default: "5" },
    rounds: { type: "string", default: "5" },
    burst: { type: "boolean", default: false },
  },
});
const fixture =
  positionals[0] ??
  fileURLToPath(new URL("../../../fixtures/claude/2.1.286/tool-read.jsonl", import.meta.url));
const Row = z.object({
  t: z.number(),
  dir: z.string(),
  channel: z.string(),
  data: z.looseObject({ type: z.string() }),
});
const recorded = readFileSync(fixture, "utf8")
  .trim()
  .split("\n")
  .slice(1)
  .flatMap((line) => {
    const row = Row.safeParse(JSON.parse(line));
    return row.success &&
      row.data.dir === "recv" &&
      row.data.channel === "sdk" &&
      !row.data.data.type.startsWith("control_")
      ? [row.data]
      : [];
  });

/** Each turn gets its own native message and tool ids, as a live session would. */
function turnFrames(turn: number, seq: { next: number }): { gap: number; frame: Frame }[] {
  let last = recorded[0]?.t ?? 0;
  return recorded.map((row) => {
    // A result closes this turn alone: no recorded input ids or queued turns behind it.
    const data =
      row.data.type === "result"
        ? {
            ...row.data,
            user_message_uuids: undefined,
            queued_turn_count: 0,
            result_index: turn + 1,
          }
        : row.data;
    const text = JSON.stringify(data)
      .replaceAll(
        /"(toolu_|msg_)([A-Za-z0-9]+)"/g,
        (_match, prefix: string, id: string) => `"${prefix}${turn}x${id}"`,
      )
      .replaceAll(/"uuid":"([^"]*)"/g, (_match, id: string) => `"uuid":"${turn}-${id}"`);
    const payload = new ProviderPayload(text);
    const gap = Math.max(0, row.t - last);
    last = row.t;
    const frame: Frame = {
      seq: seq.next++,
      t: row.t,
      dir: "recv",
      channel: "sdk",
      data: payload.data,
      payload,
    };
    return { gap, frame };
  });
}

async function round(turns: number, burst: boolean) {
  const buffer = new ManualClock();
  const h = await harness([], scriptFrames(), {
    provider: "claude",
    createTranslator,
    silenceMs: 60_000,
    storeOptions: { bufferScheduler: { delay: buffer.setTimer } },
  });
  try {
    const id = await h.create();
    const context = h.contexts[0];
    if (!context) throw new Error("Missing provider session");
    const seq = { next: 1 };
    const advance = (ms: number) => {
      h.clock.advance(h.clock.time + ms);
      buffer.advance(h.clock.time);
    };
    // Warm caches, statements and the snapshot with one untimed turn.
    for (const { frame } of turnFrames(0, seq)) await context.onFrame(frame);
    advance(2_000);
    await h.engine.flush();
    // Hold off checkpoints, so the write-ahead log's growth is every byte the turns wrote.
    h.store.atomic((db) => db.exec("PRAGMA wal_autocheckpoint=0"));
    const wal: unknown = Reflect.get(h.store, "wal");
    if (typeof wal === "object" && wal !== null) Reflect.set(wal, "wake", () => {});
    const before = { metrics: h.store.streamingMetrics(), head: h.store.headSeq() };
    const cpu = process.cpuUsage();
    for (let turn = 1; turn <= turns; turn++) {
      const sent = h.command({
        type: "thread.send",
        threadId: id,
        input: [{ type: "text", text: `turn ${turn}` }],
      });
      if (!sent.ok) throw new Error(sent.error);
      await h.engine.flush();
      const frames = turnFrames(turn, seq);
      if (burst) await Promise.all(frames.map(({ frame }) => context.onFrame(frame)));
      else
        for (const { gap, frame } of frames) {
          advance(gap);
          await context.onFrame(frame);
        }
      advance(2_000);
      await h.engine.flush();
    }
    const used = process.cpuUsage(cpu);
    const after = { metrics: h.store.streamingMetrics(), head: h.store.headSeq() };
    const thread = h.store.getThread(id);
    if (thread?.status.state !== "done") throw new Error(`Turn left ${thread?.status.state}`);
    if (h.errors.length) throw new Error(`Engine errors: ${String(h.errors[0])}`);
    return {
      cpuMs: (used.user + used.system) / 1000,
      transactions: after.metrics.transactions - before.metrics.transactions,
      events: after.head - before.head,
      walBytes: after.metrics.walBytes - before.metrics.walBytes,
    };
  } finally {
    await h.close();
  }
}

const turns = Number(values.turns);
const results: Awaited<ReturnType<typeof round>>[] = [];
for (let index = 0; index < Number(values.rounds); index++)
  results.push(await round(turns, values.burst));
const sorted = (pick: (result: (typeof results)[number]) => number): number[] =>
  results.map(pick).toSorted((a, b) => a - b);
const cpu = sorted((result) => result.cpuMs);
const first = results[0];
console.log(
  JSON.stringify({
    fixture: fixture.split("/").at(-1),
    mode: values.burst ? "burst" : "paced",
    framesPerTurn: recorded.length,
    turns,
    rounds: results.length,
    cpuMsPerTurn: { min: (cpu[0] ?? 0) / turns, median: (cpu[cpu.length >> 1] ?? 0) / turns },
    cpuMsPerFrame: (cpu[0] ?? 0) / turns / recorded.length,
    transactionsPerTurn: (first?.transactions ?? 0) / turns,
    eventsPerTurn: (first?.events ?? 0) / turns,
    cpuMsPerEvent: (cpu[0] ?? 0) / turns / ((first?.events ?? 0) / turns),
    walBytesPerEvent: Math.round((first?.walBytes ?? 0) / (first?.events || 1)),
  }),
);
