import { z } from "zod";
import { startDaemon, readConfig, Engine, AdapterRegistry, stubHandler } from "@ace/daemon";
import { Command, ThreadId } from "@ace/protocol";
import { scriptedProvider } from "./scripted.ts";
import { getHeapCodeStatistics, queryObjects } from "node:v8";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";

// Real daemon services and sockets, isolated homes, no provider executables or prompts.
const daemon = await startDaemon({
  config: readConfig(),
  handler: stubHandler(),
  modelInstances: [],
  history: { instances: [] },
  notificationChannels: {},
  toolkits: [],
  providerStatus: {
    env: { PATH: "" },
    cursorSdk: async () => ({ installed: false, auth: "unknown", loginHint: "unused" }),
  },
});
const provider = scriptedProvider();
const registry = new AdapterRegistry();
registry.register(provider.adapter, { installed: true, auth: "logged_in", loginHint: "unused" });
const errors: unknown[] = [];
const engine = new Engine(daemon.store, { registry, onError: (error) => errors.push(error) });
await engine.ready();
const workspace = daemon.store.createWorkspace(readConfig().dataDir, "Performance");
const Request = z.discriminatedUnion("op", [
  z.object({ id: z.number(), op: z.literal("sessions"), count: z.number().int().min(0).max(64) }),
  z.object({
    id: z.number(),
    op: z.literal("emit"),
    thread: ThreadId,
    count: z.number().int().positive().max(100000),
  }),
  z.object({
    id: z.number(),
    op: z.literal("cycle"),
    count: z.number().int().positive().max(64),
    fresh: z.boolean().default(false),
  }),
  z.object({ id: z.number(), op: z.literal("idle-store") }),
  z.object({ id: z.number(), op: z.literal("idle-sample") }),
  z.object({ id: z.number(), op: z.literal("close") }),
  z.object({ id: z.number(), op: z.literal("memory") }),
  z.object({ id: z.number(), op: z.literal("plans") }),
]);
let commandId = 0;
let cycling: string[] = [];
async function create() {
  const command = Command.parse({
    id: `perf-${++commandId}`,
    deviceId: "perf",
    payload: {
      type: "thread.create",
      workspaceId: workspace,
      provider: "codex",
      input: [{ type: "text", text: "script" }],
    },
  });
  const result = daemon.store.recordCommand(command.id, command.deviceId, () =>
    engine.handler.handle(command, daemon.store),
  );
  if (!result.ok || !result.threadId) throw new Error(result.error ?? "Missing thread");
  await engine.flush();
  return result.threadId;
}
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
      if (request.op === "idle-store") {
        for (let index = 0; index < 16; index++) {
          const thread = await create();
          const message = daemon.store
            .readEvents({ threadId: ThreadId.parse(thread), afterSeq: 0, limit: 16 })
            .find(
              (event) =>
                event.payload.type === "item.created" &&
                event.payload.item.type === "message" &&
                event.payload.item.role === "assistant",
            );
          if (!message || message.payload.type !== "item.created")
            throw new Error("Missing seeded message");
          const item = message.payload.item;
          if (!item.agentId) throw new Error("Missing seeded agent");
          const agentId = item.agentId;
          await provider.finish(thread);
          await engine.flush();
          // Seed bounded batches through the public Store. Idle measures the persisted
          // history, without spending minutes replaying a second artificial engine.
          for (let delta = 0; delta < 1000; delta += 100) {
            daemon.store.appendEvents(
              ThreadId.parse(thread),
              Array.from({ length: 100 }, (_, offset) => ({
                type: "item.delta" as const,
                itemId: item.id,
                agentId,
                field: "text" as const,
                append: `Historical delta ${delta + offset} with enough text to exercise the stream index.\n`,
              })),
            );
          }
        }
        if (errors.length) throw new Error(String(errors[0]));
        process.send?.({ id: request.id, threads: [], memory: process.memoryUsage() });
        return;
      }
      if (request.op === "idle-sample") {
        process.send?.({
          id: request.id,
          at: performance.now(),
          cpu: process.cpuUsage(),
          memory: process.memoryUsage(),
        });
        return;
      }
      if (request.op === "memory") {
        if (!globalThis.gc) throw new Error("Retained heap measurement requires --expose-gc");
        globalThis.gc();
        await setImmediate();
        globalThis.gc();
        await setImmediate();
        const native = {
          statements: queryObjects(StatementSync),
          databases: queryObjects(DatabaseSync),
          code: getHeapCodeStatistics(),
        };
        process.send?.({ id: request.id, threads: [], memory: process.memoryUsage(), native });
        return;
      }
      if (request.op === "plans") {
        const queryPlans = daemon.store.atomic((db) => ({
          hostEvents: db
            .prepare("EXPLAIN QUERY PLAN SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?")
            .all(0, 256),
          threadEvents: db
            .prepare(
              "EXPLAIN QUERY PLAN SELECT * FROM events WHERE seq>? AND thread_id=? ORDER BY seq LIMIT ?",
            )
            .all(0, cycling[0] ?? "missing", 256),
          engineRecords: db
            .prepare(
              "EXPLAIN QUERY PLAN SELECT value FROM engine_state_records WHERE thread_id=? AND section=? AND key=?",
            )
            .all(cycling[0] ?? "missing", "agents", "root"),
        }));
        process.send?.({ id: request.id, threads: [], memory: process.memoryUsage(), queryPlans });
        return;
      }
      let threads: string[] = [];
      if (request.op === "sessions" || request.op === "cycle") {
        if (request.op === "cycle" && cycling.length && !request.fresh) {
          threads = cycling;
          for (const id of threads) {
            const command = Command.parse({
              id: `perf-${++commandId}`,
              deviceId: "perf",
              payload: {
                type: "thread.send",
                threadId: id,
                input: [{ type: "text", text: "script" }],
              },
            });
            const result = daemon.store.recordCommand(command.id, command.deviceId, () =>
              engine.handler.handle(command, daemon.store),
            );
            if (!result.ok) throw new Error(result.error);
            await engine.flush();
          }
        } else for (let i = 0; i < request.count; i++) threads.push(await create());
        if (request.op === "cycle") {
          cycling = threads;
          for (const id of threads) {
            await provider.finish(id);
            await engine.flush();
          }
          threads = [];
        }
      } else {
        for (let i = 0; i < request.count; i++) await provider.emit(request.thread, i);
        await engine.flush();
      }
      if (errors.length) throw new Error(String(errors[0]));
      process.send?.({ id: request.id, threads, memory: process.memoryUsage() });
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
      process.send?.({ error: String(error) });
    });
});

// Publish readiness only after the engine and IPC request handler can accept work.
process.send?.({ id: 0, threads: [], memory: process.memoryUsage() });
