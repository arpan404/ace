import { portableContext } from "@ace/context";
import { boundedJson } from "@ace/provider-kit/ipc";
import { realpathSync, statSync } from "node:fs";
import { validResolution } from "./resolution.ts";
import { createThreadState } from "@ace/core";
import { Thread, type Command, type CommandResult, type ThreadId } from "@ace/protocol";
import type { CommandHandler } from "../commands.ts";
import type { EngineRepository } from "./repository.ts";
import type { AdapterRegistry } from "./registry.ts";
import type { EngineLimits } from "./limits.ts";

export function engineHandler(
  repo: EngineRepository,
  registry: AdapterRegistry,
  now: () => number,
  silenceMs: number,
  wake: (id: ThreadId) => void,
  nextId: () => string,
  limits: EngineLimits,
): CommandHandler {
  return {
    handle(command: Command): CommandResult {
      const p = command.payload;
      let deliveryCommand = command;
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
          const entry = registry.get(p.provider);
          let handoff: ReturnType<typeof portableContext> | undefined;
          if (p.handoffFrom) {
            const source = repo.store.getThread(p.handoffFrom);
            if (!source) return fail("handoff_source_not_found");
            const page = repo.store.readItemPage(
              p.handoffFrom,
              Number.MAX_SAFE_INTEGER,
              100,
              262144,
            );
            handoff = portableContext(
              {
                threadId: source.id,
                provider: source.provider,
                ...((source.backend ?? (source.provider === "cursor" ? "acp" : undefined))
                  ? { backend: source.backend ?? "acp" }
                  : {}),
              },
              page.items,
              { maxBytes: 65536, maxItems: 100, historyTruncated: page.itemsBefore !== null },
            );
            deliveryCommand = {
              ...command,
              payload: { ...p, input: [{ type: "text", text: handoff.text }, ...p.input] },
            };
          }
          const at = now();
          if (entry.adapter.backend === "cursor-sdk") {
            try {
              const input = deliveryCommand.payload;
              if (input.type === "thread.create") boundedJson(input.input, limits.maxInputBytes);
            } catch {
              return fail("provider_input_budget_exceeded");
            }
          }
          const thread = Thread.parse({
            id: nextId(),
            workspaceId: p.workspaceId,
            title: p.title ?? "New thread",
            provider: p.provider,
            capabilities: entry.capabilities,
            ...(entry.adapter.backend ? { backend: entry.adapter.backend } : {}),
            ...(handoff && p.handoffFrom
              ? {
                  handoff: {
                    sourceThreadId: p.handoffFrom,
                    truncated: handoff.truncated,
                    bytes: handoff.bytes,
                  },
                }
              : {}),
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
          repo.createSession(
            threadId,
            cwd,
            p.model,
            registry.get(p.provider).adapter.backend ??
              (p.provider === "cursor" ? "acp" : undefined),
          );
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
          if (p.type === "thread.interrupt" && p.agentId !== undefined) {
            const state = repo.requireState(threadId);
            const entry = registry.get(state.config.provider, repo.backend(threadId));
            if (
              entry.capabilities.childControls === "read-only" &&
              state.agents[state.rootKey ?? ""]?.agent.id !== p.agentId
            )
              return fail("unsupported_child_control");
          }
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
        if (p.type === "thread.send" && repo.backend(threadId) === "cursor-sdk") {
          try {
            boundedJson(p.input, limits.maxInputBytes);
          } catch {
            return fail("provider_input_budget_exceeded");
          }
          if (!repo.inputCapacity(threadId, limits.maxPendingInputs))
            return fail("provider_input_queue_full");
        }
        if (!repo.reserve(threadId)) return fail("engine_capacity_exceeded");
        repo.add(deliveryCommand, threadId, resolutionId);
        // Microtasks execute only after the enclosing receipt transaction commits.
        queueMicrotask(() => wake(threadId));
        return { commandId: command.id, ok: true };
      });
    },
  };
}
