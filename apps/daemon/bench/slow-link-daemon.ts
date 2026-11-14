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
import { recordedTurns, threadShapes, type SeedTurn } from "./slow-link-fixtures.ts";

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
  z.object({ kind: z.literal("turn"), turn: z.number().int() }),
  z.object({ kind: z.literal("stream-start"), key: z.string() }),
  z.object({ kind: z.literal("delta"), key: z.string(), text: z.string() }),
  z.object({ kind: z.literal("question"), key: z.string() }),
  z.object({ kind: z.literal("end") }),
]);
type FrameData = z.infer<typeof FrameData>;

/** Turns the provider can replay, by index; each replay gets fresh item keys. */
const turns: SeedTurn[] = [];
let replays = 0;
function turnFacts(index: number): Fact[] {
  const seeded = turns[index];
  if (!seeded) throw new Error(`No seeded turn ${index}`);
  const prefix = `r${++replays}`;
  const facts: Fact[] = [{ type: "turn.started", agent: "root", trigger: "user" }];
  for (const [position, item] of seeded.entries()) {
    const key = `${prefix}-${position}`;
    facts.push({ type: "item.upsert", agent: "root", item: key, draft: item.draft });
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
  if (data.kind === "turn") return turnFacts(data.turn);
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
    { type: "turn.started", agent: "root", trigger: "user" },
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

const shapes = threadShapes(await recordedTurns());
const threads: Record<string, { id: string; items: number; turns: number }> = {};
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
]);
let streams = 0;
let queue = Promise.resolve();
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
});
