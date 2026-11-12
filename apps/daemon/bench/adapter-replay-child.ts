/**
 * The measured side of adapter-replay.ts. Runs on Bun with BUN_JSC_logGC=1 and replays recorded
 * provider sessions through that provider's real translator, the engine, the SQLite store and the
 * WebSocket server; the parent process is the subscriber, so its socket work is not counted here.
 * Each recorded session plays into its own fresh thread, as each live session has its own
 * translator. Frames arrive as wire JSON and are admitted with ProviderPayload, as every live
 * session does; recorded gaps advance the engine's and the write buffer's manual clocks.
 */
import { writeSync } from "node:fs";
import { ProviderPayload } from "@ace/provider-kit/payload";
import type { Frame, SessionContext } from "@ace/engine-api";
import { ThreadId } from "@ace/protocol";
import { z } from "zod";
import { harness, ManualClock, scriptFrames } from "../src/engine/test-support.ts";
import { token } from "../src/socket-test-support.ts";
import { allocationMarkers, windowSampler } from "./allocation-meter.ts";
import {
  recordedSessions,
  replayProviders,
  type RecordedFrame,
  type ReplayProvider,
} from "./adapter-replay-fixtures.ts";

const argument = (name: string, fallback: string) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const selected = replayProviders[argument("provider", "claude")];
if (!selected) throw new Error(`No recorded sessions for ${argument("provider", "")}`);
const provider: ReplayProvider = selected;
const target = z.coerce.number().int().min(100).parse(argument("frames", "5000"));
const windows = z.coerce.number().int().min(1).max(20).parse(argument("windows", "3"));

const sessions = await recordedSessions(provider);
/** Sessions per window, cycled from the recorded set until the window reaches its frame target. */
const plan: { name: string; frames: RecordedFrame[] }[][] = [];
for (let window = 0, next = 0; window <= windows; window++) {
  const list = [];
  for (let frames = 0; frames < target; next++) {
    const session = sessions[next % sessions.length];
    if (!session) throw new Error("No recorded sessions");
    list.push(session);
    frames += session.frames.length;
  }
  plan.push(list);
}

/** Where a replayed frame goes: the full daemon path, or the translator alone. */
interface Sink {
  url: string;
  threads: string[][];
  advance(ms: number): void;
  frame(window: number, index: number, frame: Frame): unknown;
  flush(): Promise<void>;
  head(): number;
  transactions(): number;
  errors(): unknown[];
  close(): Promise<void>;
}

/** Translator only: frames admitted with ProviderPayload and translated, facts counted. */
function translatorSink(): Sink {
  let now = 0;
  let facts = 0;
  const translators = plan.map((list) =>
    list.map((_, index) =>
      provider.createTranslator({ threadId: ThreadId.parse(`replay-${index}`), rootKey: "root" }),
    ),
  );
  return {
    url: "",
    threads: [],
    advance(ms) {
      now += ms;
    },
    frame(window, index, frame) {
      const translator = translators[window]?.[index];
      if (!translator) throw new Error("Missing translator");
      facts += translator.translate(frame, now).length;
      facts += translator.takeDiagnostics?.().length ?? 0;
      facts += translator.tick(now).length;
      return facts;
    },
    async flush() {},
    head: () => 0,
    transactions: () => 0,
    errors: () => [],
    async close() {},
  };
}

/** The daemon path: engine, SQLite store and WebSocket server, one fresh thread per session. */
async function daemonSink(): Promise<Sink> {
  const buffer = new ManualClock();
  const h = await harness([], scriptFrames(), {
    provider: provider.provider,
    createTranslator: provider.createTranslator,
    silenceMs: provider.silenceMs,
    storeOptions: { bufferScheduler: { delay: buffer.setTimer } },
  });
  // A fresh thread and its provider session for every planned replay, made before any window.
  const targets: { threadId: string; context: SessionContext }[][] = [];
  const known = new Set<string>();
  for (const list of plan) {
    const row = [];
    for (let index = 0; index < list.length; index++) {
      const result = h.command({
        type: "thread.create",
        workspaceId: h.workspace,
        provider: provider.provider,
        model: "model",
        input: [{ type: "text", text: "replay" }],
      });
      if (!result.ok) throw new Error(result.error);
      await h.engine.flush();
      const thread = h.store.listThreads().find((candidate) => !known.has(candidate.id));
      const context = h.contexts.at(-1);
      if (!thread || !context || h.contexts.length !== known.size + 1)
        throw new Error("Thread creation did not open exactly one session");
      known.add(thread.id);
      row.push({ threadId: thread.id, context });
    }
    targets.push(row);
  }
  return {
    url: h.url,
    threads: targets.map((row) => row.map((entry) => entry.threadId)),
    advance(ms) {
      h.clock.advance(h.clock.time + ms);
      buffer.advance(h.clock.time);
    },
    frame(window, index, frame) {
      const context = targets[window]?.[index]?.context;
      if (!context) throw new Error("Missing replay session");
      return context.onFrame(frame);
    },
    flush: () => h.engine.flush(),
    head: () => h.store.headSeq(),
    transactions: () => h.store.streamingMetrics().transactions,
    errors: () => h.errors,
    close: () => h.close(),
  };
}

const stage = z.enum(["daemon", "translate"]).parse(argument("stage", "daemon"));
const sink = stage === "daemon" ? await daemonSink() : translatorSink();

function collectBetween(before: string, after?: string) {
  const bun = Reflect.get(globalThis, "Bun");
  if (typeof bun?.gc !== "function") throw new Error("Allocation windows require Bun");
  if (before) writeSync(2, `${before}\n`);
  bun.gc(true);
  if (after) writeSync(2, `${after}\n`);
}
const meter = windowSampler(
  () => process.memoryUsage().heapUsed,
  () => process.cpuUsage(),
);

async function replay(window: number): Promise<number> {
  let frames = 0;
  for (const [index, session] of (plan[window] ?? []).entries()) {
    let last = session.frames[0]?.t ?? 0;
    for (const [seq, recorded] of session.frames.entries()) {
      sink.advance(Math.max(0, recorded.t - last));
      last = recorded.t;
      const payload = new ProviderPayload(recorded.wire);
      await sink.frame(window, index, {
        seq,
        t: recorded.t,
        dir: recorded.dir,
        channel: recorded.channel,
        data: payload.data,
        payload,
      });
      frames++;
    }
    sink.advance(2_000);
  }
  await sink.flush();
  return frames;
}

const Request = z.discriminatedUnion("op", [
  z.object({ op: z.literal("window"), window: z.number().int() }),
  z.object({ op: z.literal("stop") }),
  z.object({ op: z.literal("close") }),
]);
let transactions = 0;
process.on("message", (input: unknown) => {
  void (async () => {
    const request = Request.parse(input);
    if (request.op === "window") {
      transactions = sink.transactions();
      collectBetween("", allocationMarkers.start);
      meter.start();
      const frames = await replay(request.window);
      process.send?.({ type: "replayed", frames, head: sink.head() });
    } else if (request.op === "stop") {
      const reading = meter.stop();
      collectBetween(allocationMarkers.stop, allocationMarkers.end);
      if (sink.errors().length) throw new Error(`Engine errors: ${String(sink.errors()[0])}`);
      process.send?.({
        type: "stopped",
        ...reading,
        transactions: sink.transactions() - transactions,
      });
    } else {
      await sink.close();
      process.exit(0);
    }
  })().catch((error: unknown) => {
    writeSync(2, `${String(error instanceof Error ? error.stack : error)}\n`);
    process.exit(1);
  });
});
process.send?.({
  type: "ready",
  url: sink.url,
  token,
  threads: sink.threads,
});
