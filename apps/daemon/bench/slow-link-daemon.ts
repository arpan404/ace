/**
 * The daemon side of slow-link.ts, run as its own process on Bun in a temporary home. A real
 * daemon (its TLS listener for paired devices on, and registered with a local relay when
 * ACE_RELAY_URL names one) plus a second engine sharing its store, as entry.ts does, whose
 * provider replays recorded turns (slow-link-fixtures.ts). No provider CLI runs and no prompt is
 * sent. The parent drives it over IPC and reads the endpoints from its first message.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  AdapterRegistry,
  Engine,
  readConfig,
  readHistoryInstances,
  startDaemon,
  stubHandler,
} from "@ace/daemon";
import type { Fact } from "@ace/core";
import type { Frame, ProviderAdapter, SessionContext } from "@ace/engine-api";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { Capabilities, Command, ThreadId } from "@ace/protocol";
import {
  bulkyTurns,
  itemCount,
  recordedTurns,
  threadShapes,
  type SeedTurn,
} from "./slow-link-fixtures.ts";
import { readProbe, resetProbe } from "./head-of-line-probe.ts";

const config = readConfig();
const daemon = await startDaemon({
  config,
  handler: stubHandler(),
  modelInstances: [],
  history: { instances: readHistoryInstances({ ACE_HISTORY_INSTANCES: "[]" }) },
  notificationChannels: {},
  toolkits: [],
  providerStatus: {
    env: { PATH: "" },
    cursorSdk: async () => ({ installed: false, auth: "unknown", loginHint: "unused" }),
  },
});

const FrameData = z.discriminatedUnion("kind", [
  // `pad`: provider output the frame carries beside the turn, as a large tool result's frame
  // does (head-of-line.ts reads it back with `item.raw`).
  z.object({ kind: z.literal("turn"), turn: z.number().int(), pad: z.string().optional() }),
  z.object({ kind: z.literal("stream-start"), key: z.string() }),
  z.object({ kind: z.literal("delta"), key: z.string(), text: z.string() }),
  z.object({ kind: z.literal("question"), key: z.string() }),
  // A question raised inside a turn that is already running (head-of-line.ts).
  z.object({ kind: z.literal("ask"), key: z.string() }),
  z.object({ kind: z.literal("end") }),
]);
type FrameData = z.infer<typeof FrameData>;

/** Turns the provider can replay, by index; each replay gets fresh item keys. */
const turns: SeedTurn[] = [];
let replays = 0;
/**
 * `pad` as raw provider payloads of 60 KiB each: the store moves an entry over 64 KiB to a blob
 * (sending a preview), so a full `item.raw` page is many entries under that size.
 */
function padEntries(pad: string) {
  const entries: { type: string; data: { output: string } }[] = [];
  for (let offset = 0; offset < pad.length; offset += 60 * 1024)
    entries.push({ type: "bench_output", data: { output: pad.slice(offset, offset + 60 * 1024) } });
  return entries;
}

function turnFacts(index: number, pad?: string): Fact[] {
  const seeded = turns[index];
  if (!seeded) throw new Error(`No seeded turn ${index}`);
  const prefix = `r${++replays}`;
  const facts: Fact[] = [{ type: "turn.started", agent: "root", trigger: "user" }];
  let padded = pad === undefined;
  for (const [position, item] of seeded.entries()) {
    const key = `${prefix}-${position}`;
    // `pad`: the turn's first message keeps it as a raw provider payload, as a provider frame
    // with a large output would leave (head-of-line.ts reads it back with `item.raw`).
    const draft =
      !padded && pad !== undefined && item.draft.type === "message"
        ? { ...item.draft, raw: [...(item.draft.raw ?? []), ...padEntries(pad)] }
        : item.draft;
    if (draft !== item.draft) padded = true;
    facts.push({ type: "item.upsert", agent: "root", item: key, draft });
    if (item.output)
      facts.push({
        type: "item.delta",
        agent: "root",
        item: key,
        field: "output",
        append: item.output,
      });
  }
  facts.push({ type: "turn.ended", agent: "root", outcome: "completed" });
  return facts;
}

function translate(data: FrameData): Fact[] {
  if (data.kind === "turn") return turnFacts(data.turn, data.pad);
  if (data.kind === "end") return [{ type: "turn.ended", agent: "root", outcome: "completed" }];
  if (data.kind === "stream-start")
    return [
      { type: "turn.started", agent: "root", trigger: "user" },
      {
        type: "item.upsert",
        agent: "root",
        item: data.key,
        draft: {
          type: "message",
          role: "assistant",
          parts: [{ type: "text", text: "" }],
          complete: false,
        },
      },
    ];
  if (data.kind === "delta")
    return [
      { type: "item.delta", agent: "root", item: data.key, field: "text", append: data.text },
    ];
  return [
    ...(data.kind === "question"
      ? [{ type: "turn.started" as const, agent: "root", trigger: "user" as const }]
      : []),
    {
      type: "interaction.opened",
      agent: "root",
      interaction: data.key,
      blocking: true,
      request: {
        kind: "question",
        questions: [
          {
            id: "go",
            text: "Apply the migration to the staging database now?",
            options: [
              { id: "yes", label: "Apply it" },
              { id: "no", label: "Not yet" },
            ],
            multiSelect: false,
            allowOther: false,
            secret: false,
          },
        ],
      },
    },
  ];
}

const sessions = new Map<string, SessionContext>();
let seq = 0;
const frame = (data: FrameData): Frame => {
  const payload = new ProviderPayload(JSON.stringify(data));
  return { seq: ++seq, t: 0, dir: "recv", channel: "seed", data: payload.data, payload };
};
const adapter: ProviderAdapter = {
  provider: "codex",
  capabilities: () =>
    Capabilities.parse({
      permissions: { modes: ["auto-review"], nativeAutoReview: false, toolGate: true },
      steer: false,
      interruptCascades: false,
      resume: true,
      fork: false,
      subagentTranscripts: true,
      backgroundTaskControl: true,
      backgroundVisibility: "full",
      planMode: false,
      tokenUsage: false,
      imageInput: false,
      rewindFiles: false,
    }),
  createTranslator: () => ({
    tick: () => [],
    translate: (input) => translate(FrameData.parse(input.data)),
  }),
  async openSession(context) {
    sessions.set(context.threadId, context);
    return {
      nativeSessionId: `seed-${context.threadId}`,
      // The bench plays each answer itself once the send is recorded (`turn` below).
      async send() {},
      async interrupt() {},
      async resolve() {},
      async stopTask() {},
      async close() {
        sessions.delete(context.threadId);
        context.onExit({ deliberate: true });
      },
    };
  },
};
const registry = new AdapterRegistry();
registry.register(adapter, { installed: true, auth: "logged_in", loginHint: "unused" });
const errors: unknown[] = [];
const engine = new Engine(daemon.store, { registry, onError: (error) => errors.push(error) });
await engine.ready();
const workspace = daemon.store.createWorkspace(config.dataDir, "Slow link");

const epoch = () => performance.timeOrigin + performance.now();
let commandId = 0;
async function command(payload: Command["payload"]) {
  const parsed = Command.parse({ id: `seed-${++commandId}`, deviceId: "seed", payload });
  const result = daemon.store.recordCommand(parsed.id, parsed.deviceId, () =>
    engine.handler.handle(parsed, daemon.store),
  );
  if (!result.ok) throw new Error(result.error ?? "Command refused");
  await engine.flush();
  if (errors.length) throw new Error(String(errors[0]));
  return result;
}
const prompt = (text: string) => [{ type: "text" as const, text }];

/** Sends a prompt as a person would, then plays `data` as the provider's answer. */
async function turn(threadId: string | undefined, text: string, data: FrameData) {
  const result =
    threadId === undefined
      ? await command({
          type: "thread.create",
          workspaceId: workspace,
          provider: "codex",
          input: prompt(text),
        })
      : await command({
          type: "thread.send",
          threadId: ThreadId.parse(threadId),
          input: prompt(text),
        });
  const id = threadId ?? result.threadId;
  const context = id ? sessions.get(id) : undefined;
  if (!id || !context) throw new Error("Seeded session did not open");
  const emittedAt = epoch();
  await context.onFrame(frame(data));
  await engine.flush();
  if (errors.length) throw new Error(String(errors[0]));
  return { id, context, emittedAt };
}

async function seedThread(title: string, first: number, count: number): Promise<string> {
  let threadId: string | undefined;
  for (let index = 0; index < count; index++)
    threadId = (
      await turn(threadId, `${title}: step ${index + 1}`, { kind: "turn", turn: first + index })
    ).id;
  if (!threadId) throw new Error("Nothing seeded");
  return threadId;
}

const recorded = await recordedTurns();
/**
 * The recordings' own text (tool outputs and messages, each once), for raw payloads that
 * deflate as real provider output does: repeated, it repeats only past deflate's window.
 */
const recordedPieces = new Set<string>();
for (const item of recorded.flat()) {
  if (item.output) recordedPieces.add(item.output);
  if (item.draft.type === "message")
    for (const part of item.draft.parts ?? [])
      if (part.type === "text") recordedPieces.add(part.text);
}
const recordedText = [...recordedPieces].join("\n");
const shapes = threadShapes(recorded);
const threads: Record<string, { id: string; items: number; turns: number }> = {};
/** Older threads by id, for head-of-line.ts to raise questions and sends on. */
const spares: string[] = [];
/** Where bulky turns start in `turns`, for the `bulky` op (head-of-line.ts). */
let bulkyFrom = -1;
for (const shape of shapes) {
  const first = turns.length;
  turns.push(...shape.turns);
  const id = await seedThread(`The ${shape.name} thread`, first, shape.turns.length);
  threads[shape.name] = { id, items: shape.items, turns: shape.turns.length };
}
// Older finished threads, so the sidebar has a typical page of rows to send.
for (let index = 0; index < 40; index++) {
  const id = await seedThread(`Earlier task ${index + 1}`, 0, 1);
  // One of them takes the approval sent over an idle link, the reference for head-of-line delay.
  if (index === 0) threads["idle"] = { id, items: turns[0]?.length ?? 0, turns: 1 };
  else spares.push(id);
}
// head-of-line.ts only: a 600-item thread no client has opened, one to stream into, and one to
// replay bulky turns into while a client is away.
if (process.env.SLOW_LINK_HOL) {
  const big = bulkyTurns(recorded, 600, 11);
  const first = turns.length;
  turns.push(...big);
  threads["big"] = {
    id: await seedThread("The 600-item thread", first, big.length),
    items: itemCount(big),
    turns: big.length,
  };
  bulkyFrom = first;
  threads["live"] = { id: await seedThread("The streaming thread", 0, 1), items: 0, turns: 1 };
  threads["away"] = {
    id: await seedThread("The thread worked on while away", 0, 1),
    items: 0,
    turns: 1,
  };
}

const Request = z.discriminatedUnion("op", [
  z.object({ id: z.number(), op: z.literal("question"), thread: z.string() }),
  z.object({
    id: z.number(),
    op: z.literal("stream"),
    thread: z.string(),
    deltas: z.number().int().positive(),
    bytes: z.number().int().positive(),
  }),
  z.object({ id: z.number(), op: z.literal("close") }),
  // head-of-line.ts: a stream at full rate that runs beside the other requests, until stopped.
  z.object({
    id: z.number(),
    op: z.literal("live"),
    thread: z.string(),
    bytes: z.number().int().positive(),
  }),
  z.object({ id: z.number(), op: z.literal("live-stop") }),
  // head-of-line.ts: `count` bulky turns (the 600-item thread's, 24 KiB tool outputs) played on.
  z.object({
    id: z.number(),
    op: z.literal("bulky"),
    thread: z.string(),
    count: z.number().int().positive(),
  }),
  z.object({ id: z.number(), op: z.literal("ask"), thread: z.string() }),
  z.object({
    id: z.number(),
    op: z.literal("raw-turn"),
    thread: z.string(),
    bytes: z.number().int().positive(),
  }),
  z.object({ id: z.number(), op: z.literal("probe-reset") }),
  z.object({ id: z.number(), op: z.literal("probe-read") }),
]);
/** The live stream head-of-line.ts runs, while it runs. */
let live: { stop: boolean; done: Promise<number> } | undefined;
let streams = 0;
let queue = Promise.resolve();
// The bench that started this process is gone (it crashed or was killed): stop with it rather
// than keep a daemon running in a temporary home nobody will remove.
process.once("disconnect", () => process.exit(0));
process.on("message", (input: unknown) => {
  queue = queue
    .then(async () => {
      const request = Request.parse(input);
      if (request.op === "close") {
        await engine.close();
        await daemon.close();
        process.disconnect?.();
        return;
      }
      if (request.op === "ask") {
        const context = sessions.get(request.thread);
        if (!context) throw new Error("No running session to ask on");
        const emittedAt = epoch();
        await context.onFrame(frame({ kind: "ask", key: `question-${++streams}` }));
        await engine.flush();
        process.send?.({ id: request.id, emittedAt, head: daemon.store.headSeq() });
        return;
      }
      if (request.op === "raw-turn") {
        const pad = recordedText
          .repeat(Math.ceil(request.bytes / recordedText.length))
          .slice(0, request.bytes);
        await turn(request.thread, "Run the long command", { kind: "turn", turn: 0, pad });
        process.send?.({ id: request.id, head: daemon.store.headSeq() });
        return;
      }
      if (request.op === "probe-reset") {
        resetProbe();
        process.send?.({ id: request.id });
        return;
      }
      if (request.op === "probe-read") {
        process.send?.({ id: request.id, ...readProbe() });
        return;
      }
      if (request.op === "live") {
        const key = `stream-${++streams}`;
        const { context } = await turn(request.thread, "Keep going", { kind: "stream-start", key });
        const word = "streamed tokens from a long turn ";
        const text = word.repeat(Math.ceil(request.bytes / word.length)).slice(0, request.bytes);
        const state = { stop: false, done: Promise.resolve(0) };
        // Beside the queue, so questions and other requests still run while it streams.
        state.done = (async () => {
          let sent = 0;
          while (!state.stop) {
            await context.onFrame(frame({ kind: "delta", key, text }));
            // Let the daemon's sockets and other requests run, as a provider's stream does.
            if (++sent % 8 === 0) await new Promise((resolve) => setImmediate(resolve));
          }
          await context.onFrame(frame({ kind: "end" }));
          await engine.flush();
          return sent;
        })();
        live = state;
        process.send?.({ id: request.id, emittedAt: epoch(), head: daemon.store.headSeq() });
        return;
      }
      if (request.op === "live-stop") {
        const running = live;
        live = undefined;
        if (running) running.stop = true;
        const deltas = running ? await running.done : 0;
        process.send?.({ id: request.id, deltas, head: daemon.store.headSeq() });
        return;
      }
      if (request.op === "bulky") {
        if (bulkyFrom < 0) throw new Error("Bulky turns need SLOW_LINK_HOL");
        for (let index = 0; index < request.count; index++)
          await turn(request.thread, "Next step", { kind: "turn", turn: bulkyFrom + index });
        process.send?.({ id: request.id, head: daemon.store.headSeq() });
        return;
      }
      if (request.op === "question") {
        const { emittedAt } = await turn(request.thread, "Ready to migrate?", {
          kind: "question",
          key: `question-${++streams}`,
        });
        process.send?.({ id: request.id, emittedAt, head: daemon.store.headSeq() });
        return;
      }
      const key = `stream-${++streams}`;
      const { context } = await turn(request.thread, "Keep going", { kind: "stream-start", key });
      const word = "streamed tokens from a long turn ";
      const text = word.repeat(Math.ceil(request.bytes / word.length)).slice(0, request.bytes);
      for (let index = 0; index < request.deltas; index++)
        await context.onFrame(frame({ kind: "delta", key, text }));
      await context.onFrame(frame({ kind: "end" }));
      await engine.flush();
      if (errors.length) throw new Error(String(errors[0]));
      process.send?.({ id: request.id, head: daemon.store.headSeq() });
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
      process.send?.({ error: String(error) });
    });
});

const token = readFileSync(join(config.dataDir, "daemon-token"), "utf8");
process.send?.({
  id: 0,
  endpoint: daemon.url,
  token,
  remoteUrl: daemon.remoteUrl,
  fingerprint: daemon.fingerprint,
  relayHostId: daemon.relayHostId,
  threads,
  spares,
});
