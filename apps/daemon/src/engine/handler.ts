import { isSend, maxMessageBytes } from "./queue-store.ts";
import type { Recovery } from "./recovery.ts";
import { realpathSync, statSync } from "node:fs";
import { validResolution } from "./resolution.ts";
import { createThreadState } from "@ace/core";
import { Thread, type Command, type CommandResult, type ThreadId } from "@ace/protocol";
import type { CommandHandler } from "../commands.ts";
import type { EngineRepository } from "./repository.ts";
import type { AdapterRegistry } from "./registry.ts";

export function engineHandler(
  repo: EngineRepository,
  registry: AdapterRegistry,
  now: () => number,
  silenceMs: number,
  wake: (id: ThreadId) => void,
  nextId: () => string,
  recovery: Recovery,
): CommandHandler {
  return {
    handle(command: Command): CommandResult {
      const result = recovery.handle(command);
      if (result) return result;
      const p = command.payload;
      if (
        isSend(p) &&
        (p.type === "thread.send" || p.type === "thread.create") &&
        (p.input.length > 64 || Buffer.byteLength(JSON.stringify(command)) > maxMessageBytes)
      )
        return { commandId: command.id, ok: false, error: "message_too_large" };
      const fail = (error: string): CommandResult => ({ commandId: command.id, ok: false, error });
      if (
        ![
          "thread.create",
          "thread.send",
          "thread.interrupt",
          "thread.archive",
          "interaction.resolve",
          "background_task.stop",
        ].includes(p.type)
      )
        return fail("not_implemented");
      return repo.store.atomic(() => {
        let threadId: ThreadId | undefined;
        let resolutionId: string | undefined;
        if (p.type === "thread.create") {
          if (!registry.has(p.provider)) return fail("provider_unavailable");
          const path = repo.workspace(p.workspaceId);
          if (!path) return fail("workspace_not_found");
          let cwd: string;
          try {
            cwd = realpathSync(path);
            if (!statSync(cwd).isDirectory()) return fail("workspace_unavailable");
          } catch {
            return fail("workspace_unavailable");
          }
          const at = now();
          const thread = Thread.parse({
            id: nextId(),
            workspaceId: p.workspaceId,
            title: p.title ?? "New thread",
            provider: p.provider,
            status: { state: "new" },
            createdAt: at,
            updatedAt: at,
          });
          threadId = thread.id;
          if (!repo.reserve(threadId)) return fail("engine_capacity_exceeded");
          const state = createThreadState({
            threadId,
            config: { provider: p.provider, silenceMs },
            rootAgent: {
              agent: "root",
              fidelity: "full",
              native: { provider: p.provider },
              cwd,
              ...(p.model === undefined ? {} : { model: p.model }),
            },
          });
          repo.save(state, [{ type: "thread.created", thread }], at);
          repo.createSession(threadId, cwd, p.model);
          repo.queue.ensure(threadId);
        } else if ("threadId" in p) {
          threadId = p.threadId;
          if (p.type === "thread.archive") {
            if (!repo.store.getThread(threadId)) return fail("thread_not_found");
            const at = now();
            repo.store.appendEvents(threadId, [{ type: "thread.updated", archivedAt: at }], at);
            return { commandId: command.id, ok: true };
          }
          if (!repo.state(threadId)) return fail("thread_not_found");
          if (
            p.type === "thread.interrupt" &&
            p.agentId !== undefined &&
            !Object.values(repo.requireState(threadId).agents).some(
              (record) => record.agent.id === p.agentId,
            )
          )
            return fail("agent_not_found");
        } else if (p.type === "interaction.resolve" || p.type === "background_task.stop") {
          for (const state of repo.states()) {
            if (p.type === "interaction.resolve") {
              const interaction = Object.values(state.interactions).find(
                (item) => item.id === p.interactionId,
              );
              if (!interaction) continue;
              if (interaction.state !== "pending" || repo.reserved(interaction.id))
                return fail("already_resolved");
              if (!validResolution(interaction.request, p.resolution))
                return fail("invalid_resolution");
              threadId = state.threadId;
              resolutionId = interaction.id;
              break;
            }
            const task = Object.values(state.tasks).find((entry) => entry.id === p.taskId);
            if (!task) continue;
            if (task.status !== "running" || !task.stoppable) return fail("task_not_stoppable");
            threadId = state.threadId;
            break;
          }
          if (!threadId)
            return fail(p.type === "interaction.resolve" ? "already_resolved" : "task_not_found");
        } else return fail("not_implemented");
        const admitted = recovery.admit(command, threadId);
        if (!admitted) return fail("queue_capacity_exceeded");
        if (!repo.reserve(threadId)) return fail("engine_capacity_exceeded");
        repo.add(admitted, threadId, resolutionId);
        if (p.type === "thread.create" || p.type === "thread.send") {
          repo.queue.set(threadId, {}, now());
          recovery.sync(threadId);
        }
        // Microtasks execute only after the enclosing receipt transaction commits.
        queueMicrotask(() => wake(threadId));
        return { commandId: command.id, ok: true };
      });
    },
  };
}
