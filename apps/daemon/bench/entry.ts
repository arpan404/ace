import { z } from "zod";
import { startDaemon, readConfig, Engine, AdapterRegistry, stubHandler } from "@ace/daemon";
import { Command, ThreadId } from "@ace/protocol";
import { scriptedProvider } from "./scripted.ts";

// Real daemon services and sockets, isolated homes, no provider executables or prompts.
const daemon = await startDaemon({
  config: readConfig(),
  handler: stubHandler(),
  modelInstances: [],
  history: { instances: [] },
  notificationChannels: {},
  toolkits: [],
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
  z.object({ id: z.number(), op: z.literal("cycle"), count: z.number().int().positive().max(64) }),
  z.object({ id: z.number(), op: z.literal("close") }),
  z.object({ id: z.number(), op: z.literal("memory") }),
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
      if (request.op === "memory") {
        if (!globalThis.gc) throw new Error("Retained heap measurement requires --expose-gc");
        globalThis.gc();
        globalThis.gc();
        process.send?.({ id: request.id, threads: [], memory: process.memoryUsage() });
        return;
      }
      let threads: string[] = [];
      if (request.op === "sessions" || request.op === "cycle") {
        if (request.op === "cycle" && cycling.length) {
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
