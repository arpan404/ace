import { adoptImportedThread } from "./imported-thread.ts";
import { isDefaultSelection } from "@ace/models";
import { ModelSelectionError, type EngineModels } from "./models.ts";
import { providerCommandDisabled, permissionResolutionError } from "@ace/core";
import { provisionalTitle } from "./thread-title.ts";
import { boundedJson } from "@ace/provider-kit/ipc";
import { isSend, maxMessageBytes } from "./queue-store.ts";
import type { Recovery } from "./recovery.ts";
import { validResolution } from "./resolution.ts";
import { validateCreation } from "./creation-validation.ts";
import type { CreationAdmissions } from "./creation-admissions.ts";
import { createEngineThread } from "./create-thread.ts";
import { acceptTransition } from "./transition-handler.ts";
import { baseBranchLabel, requestedBase, requestedBaseKey } from "../worktree-base.ts";
import { ExecutionOptions, ThreadId, type Command, type CommandResult } from "@ace/protocol";
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
  admissions: CreationAdmissions,
  directory: (path: string) => string,
  selectInstance?: (
    provider: string,
    backend?: import("@ace/engine-api").ProviderBackend,
  ) => string | undefined,
  machine?: { host: string; name: string },
  providerEnabled?: (provider: import("@ace/protocol").ProviderKind, instance?: string) => boolean,
  models?: EngineModels,
): CommandHandler {
  return {
    handle(command: Command, context): CommandResult {
      const payload = command.payload;
      if (payload.type === "thread.send" && repo.store.getThread(payload.threadId)?.imported) {
        try {
          adoptImportedThread(repo, payload.threadId, now());
        } catch {
          return { commandId: command.id, ok: false, error: "history_unavailable" };
        }
      }
      if (
        "threadId" in payload &&
        payload.threadId &&
        repo.cleaning(ThreadId.parse(payload.threadId))
      )
        return { commandId: command.id, ok: false, error: "thread_deleting" };
      if (
        "threadId" in payload &&
        payload.threadId &&
        repo.store.getThread(ThreadId.parse(payload.threadId))?.continuation &&
        !["thread.archive", "thread.fork"].includes(payload.type)
      )
        return {
          commandId: command.id,
          ok: false,
          error: "cursor_cli_retired",
          title: "This Cursor thread is read-only",
          detail: "Continue in a new thread to carry its history to Cursor.",
        };

      if (
        providerEnabled &&
        providerCommandDisabled(payload, {
          thread(id) {
            const thread = repo.store.getThread(id);
            return thread
              ? {
                  provider: thread.provider,
                  instanceId: repo.session(id).instanceId,
                  parentThreadId: thread.lineage?.parentThreadId,
                }
              : undefined;
          },
          defaultInstance: (provider) =>
            registry.has(provider)
              ? selectInstance?.(provider, registry.get(provider).adapter.backend)
              : undefined,
          enabled: providerEnabled,
        })
      )
        return { commandId: command.id, ok: false, error: "provider_disabled" };
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
      const fail = (error: string): CommandResult => ({
        commandId: command.id,
        ok: false,
        error,
        ...(error === "interaction_expired"
          ? {
              code: error,
              title: "Question expired",
              detail: "The provider disconnected. This question can no longer be answered.",
            }
          : error === "interaction_unavailable"
            ? {
                code: error,
                title: "Question unavailable",
                detail: "This question is no longer active.",
              }
            : {}),
      });
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
          if (!admissions.authorized(command, context.creationOwner))
            return fail("thread_creation_in_progress");
          const creation = validateCreation(
            command,
            repo,
            registry,
            limits,
            directory,
            selectInstance,
          );
          if (!creation.ok) return fail(creation.error);
          let { cwd } = creation;
          const { entry, acpIdentity, instanceId, handoff } = creation;
          deliveryCommand = creation.deliveryCommand;
          let model: string | undefined;
          try {
            model = models
              ? models.select(p.provider, p.model, instanceId, acpIdentity)
              : isDefaultSelection(p.model)
                ? undefined
                : p.model;
          } catch (error) {
            if (error instanceof ModelSelectionError) return fail("model_unavailable");
            throw error;
          }
          const at = now();
          const prepared = context.preparedWorkspace;
          const baseBranch = baseBranchLabel(p);
          threadId = ThreadId.parse(prepared?.id ?? p.threadId ?? nextId());
          if (prepared) {
            if (
              prepared.id !== p.threadId ||
              prepared.project !== cwd ||
              prepared.requestedBase !== requestedBaseKey(requestedBase(p)) ||
              p.mode !== "worktree"
            )
              return fail("workspace_preparation_mismatch");
            cwd = prepared.path;
            if (repo.store.workspaceReservations.reserved(cwd))
              return fail("workspace_change_in_progress");
          }
          if (!repo.reserve(threadId)) return fail("engine_capacity_exceeded");
          createEngineThread(repo, {
            id: threadId,
            ...(p.permissionMode ? { permissionMode: p.permissionMode } : {}),
            workspaceId: p.workspaceId,
            title:
              p.title ?? (p.type === "thread.create" ? provisionalTitle(p.input) : "New thread"),
            titleSource:
              p.type === "thread.prepare" && p.titleSource === "agent"
                ? "agent"
                : p.title !== undefined
                  ? "person"
                  : "provisional",
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
              ...(model === undefined ? {} : { model }),
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
                ...(baseBranch ? { baseBranch } : {}),
                ...(prepared?.base ? { base: prepared.base } : {}),
                ...(machine ? { machine } : {}),
              },
              live: {
                provider: p.provider,
                ...(model ? { model } : {}),
                ...(instanceId ? { account: instanceId } : {}),
                options: ExecutionOptions.parse(p.options ?? {}),
                subagentCount: 0,
                backgroundTaskCount: 0,
              },
            },
          });
          if (handoff && p.handoffFrom) {
            const source = repo.store.getThread(p.handoffFrom);
            const previous = repo.transitions.get(threadId);
            repo.transitions.set(threadId, {
              ...previous,
              context: [...previous.context, handoff.text],
            });
            repo.syntheticInput(
              threadId,
              `handoff:${command.id}`,
              handoff.text,
              {
                kind: "handoff",
                commandId: command.id,
                threadIds: [p.handoffFrom],
                lossy: true,
                ...(source
                  ? { from: { provider: source.provider, model: source.execution?.model } }
                  : {}),
                to: { provider: p.provider, model: p.model },
              },
              at,
            );
          }
          if (handoff && p.handoffFrom)
            repo.transitions.history.grant(threadId, p.handoffFrom, handoff.source.throughSeq);
          if (p.type === "thread.prepare") {
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
          if (p.type === "thread.interrupt" && p.runId !== undefined) {
            const state = repo.requireState(threadId);
            const target =
              p.agentId === undefined ? state.rootKey : state.indexes.agentKeysById[p.agentId];
            if (
              !target ||
              state.agents[target]?.activeRun !== p.runId ||
              state.runs[p.runId]?.state !== "active"
            )
              return fail("stale_interrupt");
          }
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
              if (!interaction)
                return fail(
                  repo.interactions.outcome(state.threadId, p.interactionId) === "expired"
                    ? "interaction_expired"
                    : "already_resolved",
                );
              if (interaction.state === "expired") return fail("interaction_expired");
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
        if (p.type === "thread.interrupt") {
          const queue = repo.queue.get(threadId);
          repo.queue.set(
            threadId,
            {
              paused: true,
              reason: "stopped",
              resumeAt: null,
              timerAction: null,
              holdToken: queue.holdToken + 1,
            },
            now(),
          );
        }
        repo.add(admitted, threadId, resolutionId);
        repo.admitInput(admitted, threadId, now());
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
