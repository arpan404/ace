// SPDX-License-Identifier: Apache-2.0
/**
 * Shared fixtures for E5.4d's native receipt seam tests: a thread with the queue and session rows
 * the receipt reads, and the stored intents its queue commands act on.
 */
import { createThreadState } from "@ace/core";
import { AgentId, Command, NativeSessionId, ThreadId } from "@ace/protocol";
import { engineBackend } from "@ace/provider-kit/native-switches";
import { createDevThread } from "../commands.ts";
import { AdapterRegistry } from "../engine/registry.ts";
import type { EngineOptions } from "../engine/engine-options.ts";
import { engineSeam, type EngineSeam } from "./testing.ts";

export const native = engineBackend() === "native";

/** A codex adapter entry, so the provider admission policy has a backend to ask about. */
function codexAdapter(backend: string) {
  return {
    provider: "codex",
    backend,
    capabilities: () => ({ steer: false }),
    createTranslator: () => ({}) as never,
    openSession: async () => ({}) as never,
  } as never;
}

export function codexRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(codexAdapter("sdk"), { installed: true, auth: "ok" } as never);
  return registry;
}

/** A thread the receipt's State finds, with a queue row and a session row. */
export async function seededQueue(
  options: Partial<EngineOptions> = {},
  storedResetAt?: number,
): Promise<{ seam: EngineSeam; thread: string }> {
  let thread = "";
  const seam = await engineSeam({
    options,
    afterOpen: (store) => {
      const workspace = store.createWorkspace(process.cwd(), "E5.4d");
      const created = createDevThread(store, workspace);
      thread = created.id;
      const state = createThreadState({
        threadId: ThreadId.parse(thread),
        rootAgent: {
          agent: AgentId.parse("root"),
          fidelity: "full",
          native: { provider: "codex", nativeId: NativeSessionId.parse("native-root") },
          cwd: process.cwd(),
        },
        config: { provider: "codex", silenceMs: 30_000 },
      });
      store.atomic((db) => {
        db.prepare("INSERT INTO thread_state VALUES (?, ?, ?)").run(
          thread,
          JSON.stringify({ ...state, engineSnapshot: 9 }),
          store.headSeq(),
        );
        db.prepare("INSERT INTO engine_queue (thread_id, reset_at, limited) VALUES (?, ?, 1)").run(
          thread,
          storedResetAt ?? null,
        );
        db.prepare("INSERT INTO engine_sessions (thread_id, cwd, backend) VALUES (?, ?, NULL)").run(
          thread,
          process.cwd(),
        );
      });
    },
  });
  await seam.engine.ready().catch(() => {});
  seam.probe.passThroughCollaborators();
  return { seam, thread };
}

/** A stored command, as the TypeScript store writes it. */
export function storedSend(thread: string, id: string, text = "hello") {
  return Command.parse({
    id,
    deviceId: "device",
    payload: {
      type: "thread.send",
      threadId: thread,
      input: [{ type: "text", text }],
    },
  });
}

export function seedIntent(
  seam: EngineSeam,
  thread: string,
  command: ReturnType<typeof storedSend>,
  options: { uncertain?: boolean; status?: string } = {},
): void {
  seam.store.atomic((db) =>
    db
      .prepare(
        "INSERT INTO intents (command_id,thread_id,kind,payload,status,delivery,position,uncertain) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        command.id,
        thread,
        command.payload.type,
        JSON.stringify(command),
        options.status ?? "pending",
        "queue",
        1,
        options.uncertain ? 1 : 0,
      ),
  );
}

export function setQueue(seam: EngineSeam, thread: string, patch: Record<string, unknown>): void {
  const columns = Object.keys(patch);
  seam.store.atomic((db) =>
    db
      .prepare(
        `UPDATE engine_queue SET ${columns.map((column) => `${column}=?`).join(",")} WHERE thread_id=?`,
      )
      .run(...columns.map((column) => patch[column] as string | number | null), thread),
  );
}
export async function seededRow(options: Partial<EngineOptions> = {}, ready = true) {
  let thread = "";
  const seam = await engineSeam({
    options,
    afterOpen: (store) => {
      const workspace = store.createWorkspace(process.cwd(), "E5.4d");
      thread = createDevThread(store, workspace).id;
    },
  });
  if (ready) await seam.engine.ready();
  else await seam.engine.ready().catch(() => {});
  return { seam, thread };
}
