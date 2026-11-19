import { commandNotDispatched } from "../command-not-dispatched.ts";
import { isSpadeProject } from "../project-storage.ts";
import { createWritingCli } from "../source-control-cli.ts";
import type { CreationProgress } from "../creation-progress.ts";
import { loadHostId } from "../local-files.ts";
import { computerName } from "../computer-name.ts";
import { actionErrorCode, readErrorCode } from "../action-errors.ts";
import { logError } from "@ace/diagnostics";
import { WorkspaceRefresh } from "../workspace-refresh.ts";
import { RefreshTimeout } from "../workspace-refresh-deadline.ts";
import { WorkspaceReadQueue } from "../workspace-read-queue.ts";
import { PullRequestAutoLink } from "../pr-auto-link.ts";
import {
  ThreadId,
  ForgeCommand,
  ForgeIssueCommands,
  ForgeInboxCommands,
  WorkspaceCommands,
  WorkspaceActionResult,
} from "@ace/protocol";
import { WorkspaceRuntime } from "../workspace-runtime.ts";
import { backgroundFailure } from "./background.ts";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";
/**
 * Background Git reads (lock hygiene, checkout refresh) wait this long after startup, so they
 * don't compete with the first clients for the daemon's thread and the machine's CPU.
 */
const startupQuietMs = 3_000;
export async function startWorkspaceActions({
  store,
  config,
  services,
  resources,
  now,
  options,
  log,
  diskFull,
}: ServiceContext): Promise<void> {
  const explicitTimeout = options.workspaceActions?.preparationTimeoutMs;
  let configuredTimeout = explicitTimeout;
  if (configuredTimeout == null) {
    if (config.worktreePreparationTimeoutMs != null) {
      configuredTimeout = config.worktreePreparationTimeoutMs;
    } else if (services.settings) {
      try {
        const entry = await services.settings.get("worktree.preparationTimeoutMs");
        if (typeof entry.value === "number") configuredTimeout = entry.value;
      } catch {
        /* Settings unavailable: the creation default applies. */
      }
    }
  }
  const workspace = new WorkspaceRuntime(store, config.dataDir, now, {
    log: (message, error) => log.log("warn", message, logError(error)),
    hostSkillRoots: () => services.skillLibrary?.personalRoots() ?? [],
    // A thread moving to another machine, or its subagent, opens no terminal (ADR 0191).
    moveRefusal: (id) => services.engine?.ownershipRefusal(id)?.code,
    ...options.workspaceActions,
    ...(configuredTimeout != null ? { preparationTimeoutMs: configuredTimeout } : {}),
    git: {
      ...options.workspaceActions?.git,
      onLeaseRetired: ({ lease, repository, reason }) =>
        log.log(
          "warn",
          reason === "confirmed_stale"
            ? `Cleared a stale Git lock in ${repository} after confirmation`
            : `Retired a stale Git lock in ${repository}: its daemon stopped and its checkout is gone`,
          { lease: lease.id, root: lease.root, roots: lease.roots, reason },
        ),
    },
    ...(services.sourceControl ? { sourceControl: services.sourceControl } : {}),
    ...(services.threadFiles ? { forgeMediaGrants: services.threadFiles.forgeMedia.grants } : {}),
    writingCli:
      options.workspaceActions?.writingCli ??
      createWritingCli({
        generate: (prompt, signal, limits) => {
          if (!services.utility) return Promise.reject(new Error("utility_unavailable"));
          return services.utility.models.generate(prompt, signal, limits);
        },
      }),
    machine: options.workspaceActions?.machine ?? {
      host: loadHostId(config.dataDir),
      name: await computerName(),
    },
    reconcileThread: async (id) => {
      await services.engine?.reconcileThread(id);
    },
    runsProviderWork: (id) => services.engine?.runsProviderWork(id) ?? false,
    changeWorkspace: (id, commandId, effect, reservation, commit) => {
      if (!services.engine) throw new Error("engine_unavailable");
      return services.engine.changeWorkspace(id, commandId, effect, reservation, commit);
    },
  });
  services.workspaceActions = workspace;
  // Live-update the preparation deadline from settings, unless an explicit per-environment
  // option pins it (tests). The settings service already resolves the environment override.
  if (explicitTimeout == null && services.settings) {
    try {
      const release = await services.settings.subscribe(
        { keys: ["worktree.preparationTimeoutMs"], scope: {} },
        (event) => {
          if (event.type !== "changed") return;
          const entry = event.entries.find(
            (candidate) => candidate.key === "worktree.preparationTimeoutMs",
          );
          if (entry && typeof entry.value === "number")
            workspace.setPreparationTimeoutMs(entry.value);
        },
      );
      resources.own(release);
    } catch {
      /* Settings subscriptions are best-effort: the initial value still applies. */
    }
  }
  // Hygiene behind the listener: admission retires stale leases on its own as it meets them.
  const settle = () =>
    workspace.settleWorkspaceChanges((id, error) =>
      log.log("debug", `Checkout move of ${id} could not be settled`, logError(error)),
    );
  const heal = () =>
    workspace
      .sweepStaleLeases((path, error) =>
        log.log("debug", `Git locks in ${path} could not be checked`, logError(error)),
      )
      .then(settle);
  // A move a restart cut off is settled at once: until then its project's other threads can't
  // send. The lease sweep, which spawns Git in every project, waits until a starting daemon has
  // served its clients; it settles again after, should a stale lease have held a move.
  // A pass that fails (the store unreadable a moment) is logged; the next pass runs as usual. An
  // uncaught failure would end the daemon, and a rejected chain would skip every later pass.
  const failed = backgroundFailure({ log, config, options }, "Git lock sweep failed");
  let sweep = settle().catch(failed);
  const firstHeal = setTimeout(() => {
    sweep = sweep.then(heal).catch(failed);
  }, startupQuietMs);
  firstHeal.unref();
  // Self-healing: a lease or Git lock whose process ended after admission last looked is
  // retired by the next sweep, and a checkout move it held is settled, without anyone asking.
  const healing = setInterval(() => {
    sweep = sweep.then(heal).catch(failed);
  }, 60_000);
  healing.unref();
  resources.own(() => {
    clearTimeout(firstHeal);
    clearInterval(healing);
    return sweep;
  }, "Git lock sweep");
  services.canReadThread = (_device, id) => {
    const thread = store.readThread(id);
    return thread !== undefined && thread.deletedAt === undefined;
  };
  resources.own(() => workspace.close(), "workspace Git");
  const prLinks = new PullRequestAutoLink(store, workspace, (error) =>
    log.log("debug", "Created pull request could not be linked", logError(error)),
  );
  resources.own(() => prLinks.close(), "pull request links");
  // A read that times out means something hangs (a Git or forge call); say so once per kind
  // of read, so a stuck checkout is visible without repeating every minute.
  const timedOut = new Set<string>();
  const refresh = new WorkspaceRefresh(
    store,
    workspace,
    now,
    undefined,
    (error) => {
      // A due mark the disk refused is held and retried; the full disk itself is a condition.
      if (diskFull?.observe(error)) return;
      const first = error instanceof RefreshTimeout && !timedOut.has(error.step);
      if (error instanceof RefreshTimeout) timedOut.add(error.step);
      log.log(
        first ? "warn" : "debug",
        first ? "Workspace refresh read timed out" : "Workspace metadata unavailable",
        logError(error),
      );
    },
    undefined,
    startupQuietMs,
  );
  const stopResuming = diskFull?.onRoom(() => refresh.resume());
  resources.own(() => {
    stopResuming?.();
    return refresh.close();
  }, "workspace refresh");
}
export function createWorkspaceActionsSession(context: SocketContext): SocketService {
  const { options, authorize, send, canReadThread, connected, tasks } = context;
  // A burst beyond eight running reads waits its turn; only a full backlog is refused.
  const reads = new WorkspaceReadQueue(8, 64);
  const lifetime = new AbortController();
  const generations = new Map<string, { threadId: string; controller: AbortController }>();
  const preparations = new Set<CreationProgress>();
  return {
    close() {
      lifetime.abort();
      reads.close();
      for (const entry of generations.values()) entry.controller.abort();
      generations.clear();
      for (const progress of preparations) if (!progress.action) progress.stop("cancel");
    },
    command: {
      types: [
        ...WorkspaceCommands.map((schema) => schema.shape.type.value),
        ...ForgeCommand.options.map((schema) => schema.shape.type.value),
        ...ForgeIssueCommands.map((schema) => schema.shape.type.value),
        ...ForgeInboxCommands.map((schema) => schema.shape.type.value),
      ],
      scope: (command) => (command.payload.type === "forge.pr.status" ? "read" : "operate"),
      async accept(command) {
        const p = command.payload;
        const id = "threadId" in p ? p.threadId : "link" in p ? p.link.threadId : undefined;
        if (
          !options.workspaceActions ||
          (p.type !== "forge.hosted.lifecycle" &&
            p.type !== "forge.issue.write" &&
            p.type !== "forge.issue.reconcile" &&
            p.type !== "forge.inbox.write" &&
            p.type !== "forge.hosted.review" &&
            p.type !== "forge.hosted.checks" &&
            p.type !== "forge.hosted.merge" &&
            p.type !== "forge.hosted.merge-state" &&
            p.type !== "forge.hosted.pr.create" &&
            (!id || !canReadThread(ThreadId.parse(id))))
        ) {
          send({
            type: "commandResult",
            ...commandNotDispatched(command, "workspace_unavailable"),
          });
          return;
        }
        if (p.type === "forge.pr.worktree") {
          const runtime = options.workspaceActions;
          const receipt = context.options.store.commandReceipt(command.id, command.deviceId);
          if (receipt && receipt.error !== "client_action_pending") {
            send({ type: "commandResult", ...receipt });
            return;
          }
          const existing = runtime.creationDrafts.get(command.id, command.deviceId);
          if (existing?.operation?.active) {
            send({ type: "worktree.creation.progress", ...existing.progress });
            const replay = runtime
              .execute(
                command,
                () => connected() && authorize("operate") && canReadThread(p.threadId),
                existing.operation,
              )
              .then((result) => {
                if (connected()) send({ type: "commandResult", ...result });
              })
              .catch((error: unknown) => options.log?.(error))
              .finally(() => tasks.delete(replay));
            tasks.add(replay);
            return;
          }
          let progress: CreationProgress;
          try {
            progress = await runtime.creationDrafts.begin(command, command.deviceId, (message) => {
              if (connected()) send(message);
            });
          } catch (error) {
            send({
              type: "commandResult",
              commandId: command.id,
              ok: false,
              error: actionErrorCode(error),
            });
            return;
          }
          preparations.add(progress);
          const task = runtime
            .execute(
              command,
              () => connected() && authorize("operate") && canReadThread(p.threadId),
              progress,
            )
            .then((result) => {
              progress.finish(
                result.ok ? "done" : progress.action === "cancel" ? "cancelled" : "failed",
                result.error !== "git_quarantined" && result.error !== "workspace_cleanup_required",
              );
              runtime.creationDrafts.release(command.id, result.ok);
              if (connected()) send({ type: "commandResult", ...result });
            })
            .catch((error: unknown) => {
              progress.finish("failed", false);
              runtime.creationDrafts.release(command.id, false);
              if (connected())
                send({
                  type: "commandResult",
                  commandId: command.id,
                  ok: false,
                  error: actionErrorCode(error),
                });
            })
            // Recording the failure can itself fail (a busy store); never leave it unhandled.
            .catch((error: unknown) => options.log?.(error))
            .finally(() => {
              preparations.delete(progress);
              tasks.delete(task);
            });
          tasks.add(task);
          return;
        }
        // Authority captured at admission survives a reconnect: a socket closing mid-commit or
        // mid-push is not a refusal, and the replay must find the real outcome in the receipt.
        const scope = p.type === "forge.pr.status" ? "read" : "operate";
        const lease = context.authorityLease?.(scope) ?? (() => connected() && authorize(scope));
        const result = await options.workspaceActions.execute(
          command,
          () =>
            lease() &&
            (p.type === "forge.hosted.lifecycle" ||
              p.type === "forge.issue.write" ||
              p.type === "forge.issue.reconcile" ||
              p.type === "forge.inbox.write" ||
              p.type === "forge.hosted.review" ||
              p.type === "forge.hosted.checks" ||
              p.type === "forge.hosted.merge" ||
              p.type === "forge.hosted.merge-state" ||
              p.type === "forge.hosted.pr.create" ||
              (id !== undefined && canReadThread(ThreadId.parse(id)))),
        );
        if (connected()) send({ type: "commandResult", ...result });
      },
    },
    handle(message) {
      if (message.type !== "workspace.request") return false;
      const op = message.operation;
      const scope =
        op.op === "git.draft.generate" || op.op === "git.draft.cancel" || op.op === "host.open"
          ? "operate"
          : "read";
      if (
        !authorize(scope) ||
        ("threadId" in op && op.threadId !== undefined && !canReadThread(op.threadId))
      ) {
        send({
          type: "workspace.result",
          requestId: message.requestId,
          result: { kind: "error", code: "forbidden" },
        });
        return true;
      }
      if (op.op === "git.draft.cancel") {
        const entry = generations.get(op.generationId);
        if (entry?.threadId === op.threadId) entry.controller.abort();
        send({
          type: "workspace.result",
          requestId: message.requestId,
          result: { kind: "draftCancelled" },
        });
        return true;
      }
      if (
        op.op === "git.draft.generate" &&
        (!context.maintenance.admit() || generations.has(op.input.generationId))
      ) {
        send({
          type: "workspace.result",
          requestId: message.requestId,
          // New work is paused: the same code commands get while maintenance holds them.
          result: {
            kind: "error",
            code: generations.has(op.input.generationId) ? "draft_busy" : "maintenance",
          },
        });
        return true;
      }
      const runtime = options.workspaceActions;
      const refuse = (code: string) => {
        if (op.op.startsWith("forge.")) options.warn?.("Forge read failed", { op: op.op, code });
        send({
          type: "workspace.result",
          requestId: message.requestId,
          result: { kind: "error", code },
        });
      };
      if (!runtime) {
        refuse("workspace_reads_unavailable");
        return true;
      }
      // Spade's hidden project is an empty folder, never a repository (ADR 0121): its reads are
      // answered at once, with no Git or forge work and nothing logged.
      if (
        (op.op.startsWith("forge.") || op.op.startsWith("git.")) &&
        "workspaceId" in op &&
        typeof op.workspaceId === "string" &&
        isSpadeProject(options.store, op.workspaceId)
      ) {
        send({
          type: "workspace.result",
          requestId: message.requestId,
          result: { kind: "error", code: "not_a_repo" },
        });
        return true;
      }
      const controller = new AbortController();
      if (op.op === "git.draft.generate")
        generations.set(op.input.generationId, { threadId: op.threadId, controller });
      const read = () => {
        const task = runtime
          .read(
            message,
            AbortSignal.any([lifetime.signal, controller.signal]),
            // `host.open` outside every project needs the owner's `admin`, decided on the host.
            (need = scope) =>
              connected() &&
              authorize(need) &&
              (!("threadId" in op) || op.threadId === undefined || canReadThread(op.threadId)),
          )
          .then((result) => {
            if (
              connected() &&
              authorize(scope) &&
              (!("threadId" in op) || op.threadId === undefined || canReadThread(op.threadId))
            )
              send(WorkspaceActionResult.parse(result));
          })
          .catch((error: unknown) => {
            const code = readErrorCode(op.op, error);
            if (op.op.startsWith("forge."))
              options.warn?.("Forge read failed", { op: op.op, code, error: logError(error) });
            send({
              type: "workspace.result",
              requestId: message.requestId,
              result: { kind: "error", code },
            });
          })
          .finally(() => {
            if (op.op === "git.draft.generate") generations.delete(op.input.generationId);
          });
        tasks.add(task);
        // The task answers its own failure above; this only forgets it.
        void task.finally(() => tasks.delete(task)).catch(() => {});
        return task;
      };
      if (!reads.admit(read)) {
        if (op.op === "git.draft.generate") generations.delete(op.input.generationId);
        refuse("workspace_reads_busy");
      }
      return true;
    },
  };
}
