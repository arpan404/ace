import { backup } from "node:sqlite";
import { join } from "node:path";
import { createScriptedAdapter, type ScriptedStep } from "@ace/adapter-testkit";
import { Command, type CommandPayload, type ThreadId } from "@ace/protocol";
import { Engine, Store, type EngineOptions } from "@ace/daemon";
import { harness, scriptFrames } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
export async function cleanupRecovery() {
  for (const close of cleanups.splice(0).toReversed()) await close();
}
export async function fixture(...args: Parameters<typeof harness>) {
  const h = await harness(...args);
  cleanups.push(h.close);
  return h;
}
export type RecoveryHarness = Awaited<ReturnType<typeof fixture>>;
export const text = (value: string) => [{ type: "text" as const, text: value }];
export function replaceProvider(
  h: RecoveryHarness,
  frames: ReturnType<typeof scriptFrames>,
  steps: ScriptedStep[],
) {
  const adapter = createScriptedAdapter({
    provider: "codex",
    capabilities: h.registry.get("codex").capabilities,
    nativeSessionId: "native-1",
    createTranslator: () => ({ translate: frames.translate, tick: () => [] }),
    steps,
  });
  h.registry.register(
    {
      ...adapter,
      async openSession(ctx) {
        h.contexts.push(ctx);
        const session = await adapter.openSession(ctx);
        return { ...session, instanceId: ctx.instanceId ?? "account-a" };
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  return adapter;
}
export async function restart(h: RecoveryHarness, options: EngineOptions = {}) {
  await h.engine.close();
  const engine = new Engine(h.store, { registry: h.registry, clock: h.clock, ...options });
  cleanups.push(() => engine.close());
  await engine.flush();
  return engine;
}
export async function crashCopy(h: RecoveryHarness, options: EngineOptions = {}) {
  const path = join(h.home, "crash.sqlite");
  await backup(
    h.store.atomic((db) => db),
    path,
  );
  const store = new Store(path);
  const engine = new Engine(store, { registry: h.registry, clock: h.clock, ...options });
  cleanups.push(async () => {
    await engine.close();
    await store.close();
  });
  await engine.flush();
  return { store, engine };
}
export function dispatch(
  store: Store,
  engine: Engine,
  payload: CommandPayload,
  id = "recovery-command",
) {
  const command = Command.parse({ id, deviceId: "device", payload });
  return store.recordCommand(command.id, command.deviceId, () =>
    engine.handler.handle(command, store),
  );
}
export function resume(h: RecoveryHarness, engine: Engine, id: ThreadId) {
  return dispatch(h.store, engine, {
    type: "thread.resume",
    threadId: id,
    expectedRevision: engine.queue(id).revision,
  });
}
export function sends(adapter: { commands: readonly { type: string }[] }) {
  return adapter.commands.filter((command) => command.type === "send");
}
