import { createThreadState } from "@ace/core";
import {
  Command as CommandSchema,
  type ClientMessage,
  type ServerMessage,
  type ThreadId,
} from "@ace/protocol";
import { commandContext, type CommandHandler } from "../commands.ts";
import type { ThreadActor } from "./actor.ts";
import type { AdapterRegistry } from "./registry.ts";
import type { EngineRepository } from "./repository.ts";
import type { Sessions } from "./sessions.ts";
import { defaultSilenceMs } from "./silence.ts";

/** Historical items remain in the paged Store. Only the live root enters the engine. */
export function adoptImportedThread(
  repo: EngineRepository,
  id: ThreadId,
  now: number,
  silenceMs = defaultSilenceMs,
): void {
  if (repo.state(id)) return;
  const thread = repo.store.getThread(id);
  if (!thread?.imported || !thread.rootAgentId) throw new Error("Imported thread unavailable");
  const root = repo.store.getMcpAgent(id, thread.rootAgentId);
  const workspace = repo.store.getWorkspace(thread.workspaceId);
  if (!root || !workspace) throw new Error("Imported project unavailable");
  const nativeId = root.native.nativeId ?? thread.imported.native.nativeId;
  if (!nativeId) throw new Error("Native session identity unavailable");
  // The root enters as plain data before the core owns the state: a created state is read-only.
  const state = createThreadState({
    threadId: id,
    config: { provider: thread.provider, silenceMs },
    seed: (state) => {
      state.rootKey = "root";
      state.agents.root = { agent: root, activity: "thinking", lastSignalAt: now };
      state.indexes.agentKeysById[root.id] = "root";
    },
  });
  repo.store.atomic(() => {
    repo.createSession(id, workspace.path, root.model, undefined, thread.imported?.instanceId);
    repo.nativeSession(id, nativeId);
    repo.permissions.ensure(id);
    repo.queue.ensure(id);
    repo.save(state, [], now);
  });
}

export async function continueImportedThread(
  ports: {
    ready(): Promise<void>;
    repo: EngineRepository;
    registry: AdapterRegistry;
    sessions: Sessions;
    handler: CommandHandler;
    now(): number;
    silenceMs(workspaceId: import("@ace/protocol").WorkspaceId): number;
    actor(id: ThreadId): ThreadActor;
    flush(): Promise<void>;
  },
  request: Extract<ClientMessage, { type: "history.continue" }>,
  signal: AbortSignal,
): Promise<ServerMessage> {
  await ports.ready();
  signal.throwIfAborted();
  const thread = ports.repo.store.getThread(request.threadId);
  if (!thread?.imported) throw new Error("Imported thread unavailable");
  const entry = ports.registry.has(thread.provider)
    ? ports.registry.get(thread.provider)
    : undefined;
  if (!entry?.capabilities.resume || request.mode !== "resume")
    return {
      type: "history.continue",
      status: "unsupported",
      reason: "Import this session to read it. This provider cannot continue it in ace.",
    };
  await ports.repo.store.writable();
  adoptImportedThread(ports.repo, thread.id, ports.now(), ports.silenceMs(thread.workspaceId));
  if (!ports.repo.reserve(thread.id)) throw new Error("Too many active threads");
  const actor = ports.actor(thread.id);
  try {
    await ports.sessions.open(actor);
    signal.throwIfAborted();
    await actor.flush();
    if (!actor.session) throw new Error("Provider stopped while opening the session");
    if (request.input.length) {
      const command = CommandSchema.parse({
        id: ports.repo.nextCommandId(),
        deviceId: "ace-history",
        threadId: thread.id,
        payload: {
          type: "thread.send",
          threadId: thread.id,
          input: request.input,
          delivery: request.delivery,
        },
      });
      const result = ports.handler.handle(command, commandContext(ports.repo.store));
      if (!result.ok) throw new Error(result.error ?? "Message could not be sent");
      await ports.flush();
    }
    return {
      type: "history.continue",
      status: "continued",
      threadId: thread.id,
      instanceId: thread.imported.instanceId,
      nativeSessionId:
        actor.session?.nativeSessionId ??
        ports.repo.session(thread.id).nativeSessionId ??
        thread.imported.native.nativeId ??
        "",
    };
  } catch (error) {
    if (!actor.session) ports.repo.release(thread.id);
    throw error;
  }
}
