import { portableContext } from "@ace/context";
import { permissionResolutionError } from "@ace/core";
import { boundedJson } from "@ace/provider-kit/ipc";
import { isSend, maxMessageBytes } from "./queue-store.ts";
import type { Recovery } from "./recovery.ts";
import { realpathSync, statSync } from "node:fs";
import { validResolution } from "./resolution.ts";
import { createEngineThread } from "./create-thread.ts";
import { acceptTransition } from "./transition-handler.ts";
import {
  ExecutionOptions,
  AcpIdentity,
  ThreadId,
  type Command,
  type CommandResult,
} from "@ace/protocol";
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
  recovery: Recovery,
  limits: EngineLimits,
  selectInstance?: (
    provider: string,
    backend?: import("@ace/engine-api").ProviderBackend,
  ) => string | undefined,
  machine?: { host: string; name: string },
): CommandHandler {
  return {
    handle(command: Command, context): CommandResult {
      const payload = command.payload;
      if ("threadId" in payload && payload.threadId) {
        const id = ThreadId.parse(payload.threadId);
        if (repo.store.workspaceReservations.threadReserved(id))
          return { commandId: command.id, ok: false, error: "workspace_change_in_progress" };
      }
      const result = recovery.handle(command);
      if (result) return result;
      const transition = acceptTransition(
        repo,
        registry,
        command,
        now(),
        nextId,
        wake,
        selectInstance,
      );
      if (transition) return transition;
      const p = command.payload;
      if (p.type === "thread.permission.set") {
        const state = repo.state(p.threadId);
        if (!state) return { commandId: command.id, ok: false, error: "thread_not_found" };
        return (
          repo.permissions.accept(
            command,
            registry.get(state.config.provider, repo.backend(p.threadId)).capabilities,
            now(),
          ) ?? { commandId: command.id, ok: false, error: "not_implemented" }
        );
      }
      let deliveryCommand = command;
      if (
        "threadId" in p &&
        p.threadId &&
        (repo.store.getThread(ThreadId.parse(p.threadId))?.details?.workspaceChange?.state ===
          "preparing" ||
          repo.store.getThread(ThreadId.parse(p.threadId))?.details?.workspaceChange?.uncertain)
      )
        return { commandId: command.id, ok: false, error: "workspace_change_in_progress" };
      if (isSend(p) && (p.type === "thread.send" || p.type === "thread.create")) {
        try {
          if (p.input.length > 64)
            return { commandId: command.id, ok: false, error: "message_too_large" };
          boundedJson(command, maxMessageBytes);
        } catch {
          return { commandId: command.id, ok: false, error: "message_too_large" };
        }
      }
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
          if (repo.store.workspaceReservations.reserved(cwd))
            return fail("workspace_change_in_progress");
          const entry = registry.get(p.provider);
          if (p.permissionMode && !entry.capabilities.permissions?.modes.includes(p.permissionMode))
            return fail("permission_mode_unsupported");
          const accountId = p.accountId ?? ("account" in p ? p.account : undefined);
          if (p.type === "thread.create" && p.instanceId && accountId && p.instanceId !== accountId)
            return fail("conflicting_account_selection");
          const instanceId =
            (p.type === "thread.create" ? p.instanceId : undefined) ??
            accountId ??
            selectInstance?.(p.provider, entry.adapter.backend);
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
                throughSeq: page.seq,
                totalItems: repo.store.historicalItemCount(source.id, page.seq),
                ...((source.backend ?? (source.provider === "cursor" ? "acp" : undefined))
                  ? { backend: source.backend ?? "acp" }
                  : {}),
              },
              page.items,
              { maxBytes: 65536, maxItems: 100, historyTruncated: page.itemsBefore !== null },
            );
            if (p.type === "thread.create")
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
          if (
            p.options &&
            Object.keys(p.options)
              .filter((key) => key === "effort" || key === "serviceTier")
              .some(
                (option) =>
                  !registry
                    .get(p.provider)
                    .capabilities.launchOptions?.some((supported) => supported === option),
              )
          )
            return fail("launch_options_unsupported");
          const prepared = context.preparedWorkspace;
          threadId = ThreadId.parse(prepared?.id ?? p.threadId ?? nextId());
          if (prepared) {
            cwd = prepared.path;
            if (repo.store.workspaceReservations.reserved(cwd))
              return fail("workspace_change_in_progress");
          }
          if (!repo.reserve(threadId)) return fail("engine_capacity_exceeded");
          createEngineThread(repo, {
            id: threadId,
            ...(p.permissionMode ? { permissionMode: p.permissionMode } : {}),
            workspaceId: p.workspaceId,
            title: p.title ?? "New thread",
            ...(acpIdentity ? { acpIdentity } : {}),
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
            selection: {
              provider: p.provider,
              options: ExecutionOptions.parse(p.options ?? {}),
              ...(instanceId ? { instanceId } : {}),
              ...(p.model === undefined ? {} : { model: p.model }),
            },
            cwd,
            workspaceReady: Boolean(prepared),
            at,
            silenceMs,
            client: {
              ...(p.type === "thread.prepare" && p.deck ? { deck: p.deck } : {}),
              details: {
                workspace: {
                  id: p.workspaceId,
                  name: repo.store.getWorkspace(p.workspaceId)?.name ?? p.workspaceId,
                  path: cwd,
                },
                mode: ("mode" in p ? p.mode : undefined) ?? "local",
                worktree: cwd,
                ...(prepared ? { branch: prepared.branch } : {}),
                ...("baseBranch" in p && p.baseBranch ? { baseBranch: p.baseBranch } : {}),
                ...(machine ? { machine } : {}),
              },
              live: {
                provider: p.provider,
                ...(p.model ? { model: p.model } : {}),
                ...(instanceId ? { account: instanceId } : {}),
                options: ExecutionOptions.parse(p.options ?? {}),
                subagentCount: 0,
                backgroundTaskCount: 0,
              },
            },
          });
          if (handoff && p.handoffFrom)
            repo.transitions.history.grant(threadId, p.handoffFrom, handoff.source.throughSeq);
          if (p.type === "thread.prepare") {
            if (handoff) {
              const previous = repo.transitions.get(threadId);
              repo.transitions.set(threadId, {
                ...previous,
                context: [...previous.context, handoff.text],
              });
            }
            repo.release(threadId);
            return { commandId: command.id, ok: true, threadId };
          }
        } else if ("threadId" in p) {
          threadId = ThreadId.parse(p.threadId);
          if (p.type === "thread.archive") {
            if (!repo.store.getThread(threadId)) return fail("thread_not_found");
            const at = now();
            repo.store.appendEvents(threadId, [{ type: "thread.updated", archivedAt: at }], at);
            return { commandId: command.id, ok: true };
          }
          if (repo.store.getThread(threadId)?.deletedAt !== undefined)
            return fail("thread_not_found");
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
          const owner = repo.entityThread(
            p.type === "interaction.resolve" ? "interactions" : "backgroundTasks",
            p.type === "interaction.resolve" ? p.interactionId : p.taskId,
          );
          const state = owner ? repo.state(owner) : undefined;
          if (state) {
            if (p.type === "interaction.resolve") {
              const key = repo.nativeEntity(state.threadId, "interactions", p.interactionId);
              const interaction = key === undefined ? undefined : state.interactions[key];
              if (!interaction) return fail("already_resolved");
              if (interaction.state !== "pending" || repo.reserved(interaction.id))
                return fail("already_resolved");
              if (!validResolution(interaction.request, p.resolution))
                return fail("invalid_resolution");
              const permissionError = permissionResolutionError(
                repo.permissions.effective(state.threadId),
                interaction.request,
                p.resolution,
              );
              if (permissionError) return fail(permissionError);
              threadId = state.threadId;
              resolutionId = interaction.id;
            } else {
              const key = repo.nativeEntity(state.threadId, "tasks", p.taskId);
              const task = key === undefined ? undefined : state.tasks[key];
              if (!task) return fail("task_not_found");
              if (task.status !== "running" || !task.stoppable) return fail("task_not_stoppable");
              threadId = state.threadId;
            }
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
        const admitted = recovery.admit(deliveryCommand, threadId);
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
