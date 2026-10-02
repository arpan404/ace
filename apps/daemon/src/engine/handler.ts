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
): CommandHandler {
  return {
    handle(command: Command): CommandResult {
      const p = command.payload;
      const fail = (error: string): CommandResult => ({ commandId: command.id, ok: false, error });
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
        } else if ("threadId" in p) {
          threadId = p.threadId;
          if (!repo.state(threadId)) return fail("thread_not_found");
          if (p.type === "thread.archive") {
            repo.store.appendEvents(
              threadId,
              [{ type: "thread.updated", archivedAt: now() }],
              now(),
            );
            return { commandId: command.id, ok: true };
          }
          if (
            p.type === "thread.interrupt" &&
            p.agentId !== undefined &&
            !Object.values(repo.requireState(threadId).agents).some(
              (record) => record.agent.id === p.agentId,
            )
          )
            return fail("agent_not_found");
        } else {
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
        }
        if (!repo.reserve(threadId)) return fail("engine_capacity_exceeded");
        repo.add(command, threadId, resolutionId);
        // Microtasks execute only after the enclosing receipt transaction commits.
        queueMicrotask(() => wake(threadId));
        return { commandId: command.id, ok: true };
      });
    },
  };
}
