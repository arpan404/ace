import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createScriptedAdapter, type ScriptedStep } from "@ace/adapter-testkit";
import type { Fact } from "@ace/core";
import type { Frame, SessionContext, ProviderAdapter } from "@ace/engine-api";
import { ProviderPayload } from "@ace/provider-kit/payload";
import {
  Command,
  Capabilities,
  type CommandPayload,
  type ServerMessage,
  type ProviderKind,
} from "@ace/protocol";
import { Store, Engine, AdapterRegistry, type EngineClock, type EngineOptions } from "@ace/daemon";
import { startServer } from "../server.ts";
import { Client, token } from "../socket-test-support.ts";

export class ManualClock implements EngineClock {
  time = 1_000;
  private timers = new Set<{ at: number; callback: () => void }>();
  private registrations = new Map<number, (() => void)[]>();
  waitForDelay(delay: number): Promise<void> {
    return new Promise((resolve) => {
      const observers = this.registrations.get(delay) ?? [];
      observers.push(resolve);
      this.registrations.set(delay, observers);
    });
  }
  now = () => this.time;
  setTimer = (callback: () => void, delay: number) => {
    const timer = { at: this.time + delay, callback };
    this.timers.add(timer);
    for (const resolve of this.registrations.get(delay) ?? []) resolve();
    this.registrations.delete(delay);
    return () => {
      this.timers.delete(timer);
    };
  };
  advance(to: number): void {
    this.time = to;
    for (const timer of this.timers)
      if (timer.at <= to) {
        this.timers.delete(timer);
        timer.callback();
      }
  }
}
export const start = { type: "turn.started", agent: "root", trigger: "user" } satisfies Fact;
export const end = { type: "turn.ended", agent: "root", outcome: "completed" } satisfies Fact;
export const question: Fact = {
  type: "interaction.opened",
  agent: "root",
  interaction: "approval",
  blocking: true,
  request: {
    kind: "approval",
    title: "Continue?",
    options: [{ id: "yes", label: "Yes", kind: "allow_once" }],
  },
};
export const task: Fact = {
  type: "background.started",
  agent: "root",
  task: "shell",
  kind: "shell",
  title: "Background build",
  stoppable: true,
};
export function scriptFrames() {
  const bundles = new Map<string, Fact[]>();
  let seq = 0;
  return {
    frame(...facts: Fact[]): Frame {
      const channel = `facts-${++seq}`;
      bundles.set(channel, facts);
      const payload = new ProviderPayload('{"scripted":true}');
      return { seq, t: seq, dir: "recv", channel, data: payload.data, payload };
    },
    translate(frame: Frame): Fact[] {
      return structuredClone(bundles.get(frame.channel) ?? []);
    },
  };
}
export async function harness(
  steps: ScriptedStep[],
  frames: ReturnType<typeof scriptFrames>,
  options: {
    models?: EngineOptions["models"];
    limits?: EngineOptions["limits"];
    recovery?: EngineOptions["recovery"];
    preferences?: EngineOptions["preferences"];
    permissionSettings?: EngineOptions["permissionSettings"];
    providerEnabled?: EngineOptions["providerEnabled"];
    prepareInput?: EngineOptions["prepareInput"];
    beforeSend?: EngineOptions["beforeSend"];
    steer?: boolean;
    idleMs?: number;
    tick?: (now: number) => Fact[];
    nextDeadline?: () => number | undefined;
    resolveGate?: Promise<void>;
    provider?: ProviderKind;
    capabilities?: Capabilities;
    nativeAdapter?: ProviderAdapter;
  } = {},
) {
  const home = mkdtempSync(join(tmpdir(), "ace-engine-"));
  const path = join(home, "events.sqlite");
  const store = new Store(path);
  const workspace = store.createWorkspace(home, "Workspace");
  const clock = new ManualClock();
  const contexts: SessionContext[] = [];
  const adapter = createScriptedAdapter({
    provider: options.provider ?? "codex",
    nativeSessionId: "native-1",
    capabilities:
      options.capabilities ??
      Capabilities.parse({
        steer: options.steer ?? false,
        interruptCascades: false,
        resume: true,
        fork: false,
        subagentTranscripts: true,
        backgroundTaskControl: true,
        backgroundVisibility: "full",
        planMode: false,
        tokenUsage: false,
        imageInput: true,
        rewindFiles: false,
      }),
    createTranslator: () => ({
      translate: frames.translate,
      tick: options.tick ?? (() => []),
      ...(options.nextDeadline ? { nextDeadline: options.nextDeadline } : {}),
    }),
    steps,
  });
  const registry = new AdapterRegistry();
  registry.register(
    {
      ...(options.nativeAdapter ?? adapter),
      ...(options.provider === "acp" ? { acceptsIdentity: () => true } : {}),
      async openSession(ctx) {
        contexts.push(ctx);
        const session = await (options.nativeAdapter ?? adapter).openSession(ctx);
        if (!options.resolveGate) return session;
        const resolve = session.resolve.bind(session);
        session.resolve = async (interaction, resolution) => {
          await options.resolveGate;
          return resolve(interaction, resolution);
        };
        return session;
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  const errors: unknown[] = [];
  const engine = new Engine(store, {
    registry,
    ...(options.models ? { models: options.models } : {}),
    ...(options.providerEnabled ? { providerEnabled: options.providerEnabled } : {}),
    ...(options.recovery ? { recovery: options.recovery } : {}),
    ...(options.preferences ? { preferences: options.preferences } : {}),
    ...(options.permissionSettings ? { permissionSettings: options.permissionSettings } : {}),
    ...(options.prepareInput ? { prepareInput: options.prepareInput } : {}),
    ...(options.beforeSend ? { beforeSend: options.beforeSend } : {}),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    clock,
    idleMs: options.idleMs ?? 30_000,
    silenceMs: 100,
    onError: (error) => errors.push(error),
  });
  const server = await startServer({
    port: 0,
    token,
    hostId: "host",
    store,
    handler: engine.handler,
    engine,
  });
  const clients: Client[] = [];
  function command(payload: CommandPayload, deviceId = "device", id: string = randomUUID()) {
    const value = Command.parse({ id, deviceId, payload });
    return store.recordCommand(value.id, value.deviceId, () => engine.handler.handle(value, store));
  }
  async function connect(deviceId: string) {
    const client = new Client(server.url);
    clients.push(client);
    await once(client.socket, "open");
    client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: Command.parse({
        id: "hello",
        deviceId,
        payload: {
          type: "thread.create",
          workspaceId: workspace,
          provider: "codex",
          input: [{ type: "text", text: "hi" }],
        },
      }).deviceId,
      token,
    });
    await client.next();
    return client;
  }
  return {
    home,
    path,
    store,
    workspace,
    clock,
    adapter,
    contexts,
    registry,
    engine,
    command,
    connect,
    errors,
    async create() {
      const result = command({
        type: "thread.create",
        workspaceId: workspace,
        provider: options.provider ?? "codex",
        ...(options.provider === "acp"
          ? {
              acpAgentId: "test-agent",
              installationId: "test-install",
              instanceId: "test-instance",
            }
          : {}),
        model: "model",
        input: [{ type: "text", text: "first" }],
      });
      if (!result.ok) throw new Error(result.error);
      const thread = store.listThreads()[0];
      if (!thread) throw new Error("Missing created thread");
      await engine.flush();
      return thread.id;
    },
    async close() {
      for (const client of clients) await client.close();
      await server.close();
      await engine.close();
      await store.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
export async function until(client: Client, predicate: (message: ServerMessage) => boolean) {
  for (;;) {
    const message = await client.next();
    if (predicate(message)) return message;
  }
}
