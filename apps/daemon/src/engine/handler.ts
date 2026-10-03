import { isSend, maxMessageBytes } from "./queue-store.ts";
import type { Recovery } from "./recovery.ts";
import { realpathSync, statSync } from "node:fs";
import { validResolution } from "./resolution.ts";
import { createEngineThread } from "./create-thread.ts";
import { acceptTransition } from "./transition-handler.ts";
import { AcpIdentity, ThreadId, type Command, type CommandResult } from "@ace/protocol";
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
      const transition = acceptTransition(repo, registry, command, now(), nextId, wake);
      if (transition) return transition;
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
          "thread.prepare",
          "thread.send",
          "thread.interrupt",
          "thread.archive",
          "thread.model.set",
          "thread.mode.set",
          "interaction.resolve",
          "background_task.stop",
        ].includes(p.type)
      )
        return fail("not_implemented");
      return repo.store.atomic(() => {
        let threadId: ThreadId | undefined;
        let resolutionId: string | undefined;
        if (p.type === "thread.create" || p.type === "thread.prepare") {
          const identity = p.provider === "acp" ? AcpIdentity.safeParse(p) : undefined;
          if (p.provider === "acp" && !identity?.success) return fail("acp_identity_required");
          const acpIdentity = identity?.success ? identity.data : undefined;
          if (!registry.has(p.provider, acpIdentity)) return fail("provider_unavailable");
          const path = repo.workspace(p.workspaceId);
          if (!path) return fail("workspace_not_found");
          let cwd: string;
          try {
            cwd = realpathSync(path);
            if (!statSync(cwd).isDirectory()) return fail("workspace_unavailable");
          } catch {
            return fail("workspace_unavailable");
          }
          if (
            p.options &&
            Object.keys(p.options).some(
              (option) =>
                !registry
                  .get(p.provider)
                  .capabilities.launchOptions?.some((supported) => supported === option),
            )
          )
            return fail("launch_options_unsupported");
          const at = now();
          threadId = ThreadId.parse(p.threadId ?? nextId());
          if (!repo.reserve(threadId)) return fail("engine_capacity_exceeded");
          createEngineThread(repo, {
            id: threadId,
            workspaceId: p.workspaceId,
            title: p.title ?? "New thread",
            ...(acpIdentity ? { acpIdentity } : {}),
            selection: {
              provider: p.provider,
              options: {
                ...(p.options?.effort ? { effort: p.options.effort } : {}),
                ...(p.options?.serviceTier ? { serviceTier: p.options.serviceTier } : {}),
              },
              ...(p.accountId ? { instanceId: p.accountId } : {}),
              ...(p.model === undefined ? {} : { model: p.model }),
            },
            cwd,
            at,
            silenceMs,
          });
          if (p.type === "thread.prepare") {
            repo.release(threadId);
            return { commandId: command.id, ok: true, threadId };
          }
        } else if ("threadId" in p) {
          threadId = p.threadId;
          if (p.type === "thread.archive") {
            if (!repo.store.getThread(threadId)) return fail("thread_not_found");
            const at = now();
            repo.store.appendEvents(threadId, [{ type: "thread.updated", archivedAt: at }], at);
            return { commandId: command.id, ok: true };
          }
          if (!repo.state(threadId)) return fail("thread_not_found");
          if (p.type === "thread.send" && repo.transitions.guarded(threadId))
            return fail("thread_transition_in_progress");
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
        const heldSend = p.type === "thread.send" && repo.queue.get(threadId).paused;
        if (!heldSend && !repo.reserve(threadId)) return fail("engine_capacity_exceeded");
        const released = p.type === "thread.interrupt" ? repo.cancelPending(threadId, now()) : [];
        repo.add(admitted, threadId, resolutionId);
        if (p.type === "thread.create" || p.type === "thread.send") {
          repo.queue.set(threadId, {}, now());
          recovery.sync(threadId);
        }
        // Microtasks execute only after the enclosing receipt transaction commits.
        queueMicrotask(() => {
          if (repo.state(threadId)) wake(threadId);
          for (const id of released) wake(id);
        });
        return { commandId: command.id, ok: true, threadId };
      });
    },
  };
}
