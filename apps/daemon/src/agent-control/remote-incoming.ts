import { incomingRemoteContext, remoteContextTransfer } from "./remote-context-transfer.ts";
import { fingerprint } from "@ace/secure-channel";
import { validRemoteTask } from "./remote-identity.ts";
import { threadCleaning } from "../thread-cleanup-journal.ts";
import { commandContext } from "../commands.ts";
import { z } from "zod";
import {
  CommandId,
  Command,
  DeviceId,
  RemoteTask,
  ThreadId,
  type ServerMessage,
} from "@ace/protocol";
import { threadOutcome } from "./results.ts";
import { createEngineSession } from "../services/creation-session.ts";
import type { SocketContext, SocketService } from "../services/socket.ts";

const owner = DeviceId.parse("ace-remote-agent");
/** Target admission belongs to the task, so replacing an authenticated broker cannot lose it. */
export function createRemoteIncomingSession(context: SocketContext): SocketService {
  const store = context.options.store;
  store.atomic((db) =>
    db.exec(
      `CREATE TABLE IF NOT EXISTS remote_agent_incoming (id TEXT PRIMARY KEY,thread_id TEXT NOT NULL UNIQUE,record JSON NOT NULL);`,
    ),
  );
  function read(id: string): RemoteTask | undefined {
    const row = store.atomic((db) =>
      db.prepare("SELECT record FROM remote_agent_incoming WHERE id=?").get(id),
    );
    return row ? RemoteTask.parse(JSON.parse(z.string().parse(row.record))) : undefined;
  }
  const creations = new Set<SocketService>();
  return {
    close() {
      for (const creation of creations) creation.close?.();
      creations.clear();
    },
    async handle(message) {
      if (message.type === "delegation.remote.transport") {
        const relay = context.options.relay;
        context.send({
          type: "delegation.broker.result",
          requestId: message.requestId,
          ok: context.authorize("read"),
          ...(relay && context.authorize("read")
            ? { relay: { url: relay.url, pinnedFingerprint: fingerprint(relay.keys.publicKey) } }
            : {}),
        });
        return true;
      }
      if (message.type === "delegation.remote.context") {
        const scope = message.operation.op === "read" ? "read" : "operate";
        context.send(
          await remoteContextTransfer(
            context.options,
            message,
            (thread) =>
              context.connected() &&
              context.authorize(scope) &&
              (!thread || context.canReadThread(ThreadId.parse(thread))),
          ),
        );
        return true;
      }
      if (
        message.type !== "delegation.remote.start" &&
        message.type !== "delegation.remote.status" &&
        message.type !== "delegation.remote.cancel"
      )
        return false;
      const id = message.type === "delegation.remote.start" ? message.task.id : message.taskId;
      const base = { type: "delegation.broker.result" as const, requestId: message.requestId };
      const task = read(id);
      const thread = task && store.getThread(task.threadId);
      const scope = message.type === "delegation.remote.status" ? "read" : "operate";
      // Deleted tasks disclose no transcript, usage or project data; return only the
      // known task's cleanup acknowledgement, even when ordinary tombstone reads are denied.
      if (
        ["delegation.remote.status", "delegation.remote.cancel"].includes(message.type) &&
        task &&
        (!thread || thread.deletedAt !== undefined || threadCleaning(store, task.threadId)) &&
        context.connected() &&
        context.authorize(scope) &&
        store.commandReceipt(CommandId.parse(`remote-create:${id}`), owner)?.ok
      ) {
        const engine = context.options.engine;
        const live = engine?.liveWork(task.threadId);
        const pending =
          !engine ||
          engine.creationPending(task.threadId) ||
          !live ||
          live.agentsRunning > 0 ||
          live.operationsRunning > 0 ||
          threadCleaning(store, task.threadId);
        context.send({ ...base, ok: true, phase: pending ? "cancelling" : "cancelled" });
        return true;
      }
      if (
        !context.connected() ||
        !context.authorize(scope) ||
        (thread && !context.canReadThread(thread.id))
      ) {
        context.send({ ...base, ok: false, error: "forbidden" });
        return true;
      }
      const createId = CommandId.parse(`remote-create:${id}`);
      if (message.type === "delegation.remote.start") {
        const input = message.task;
        if (
          !validRemoteTask(input, context.options.hostId) ||
          (task &&
            JSON.stringify([
              task.sourceHostId,
              task.parentThreadId,
              task.parentAgentId,
              task.request,
              task.permissionMode,
            ]) !==
              JSON.stringify([
                input.sourceHostId,
                input.parentThreadId,
                input.parentAgentId,
                input.request,
                input.permissionMode,
              ]))
        ) {
          context.send({ ...base, ok: false, error: "invalid" });
          return true;
        }
        if (!task)
          store.atomic((db) =>
            db
              .prepare("INSERT INTO remote_agent_incoming VALUES (?,?,?)")
              .run(id, input.threadId, JSON.stringify(input)),
          );
        let attachmentContext: import("@ace/protocol").MessageContext | undefined;
        try {
          attachmentContext = incomingRemoteContext(context.options, input);
        } catch {
          context.send({ ...base, ok: false, error: "not_ready" });
          return true;
        }
        const command = Command.parse({
          id: createId,
          deviceId: owner,
          payload: {
            type: "thread.create",
            threadId: input.threadId,
            workspaceId: input.request.workspaceId,
            provider: input.request.provider,
            permissionMode: input.permissionMode,
            mode: input.request.mode,
            ...(input.request.model ? { model: input.request.model } : {}),
            ...(input.request.accountId ? { accountId: input.request.accountId } : {}),
            ...(input.request.options ? { options: input.request.options } : {}),
            ...(input.request.acpAgentId ? { acpAgentId: input.request.acpAgentId } : {}),
            ...(input.request.installationId
              ? { installationId: input.request.installationId }
              : {}),
            ...(input.request.instanceId ? { instanceId: input.request.instanceId } : {}),
            ...(attachmentContext ? { context: attachmentContext } : {}),
            title: input.request.role,
            trigger: "spawn",
            origin: { kind: "spawn", role: `remote-device:${input.sourceHostId}` },
            input: [
              {
                type: "text",
                text: `Delegated task ${id} from host ${input.sourceHostId}, thread ${input.parentThreadId}. Work on this device/project only. Return a concise result. Files remain on this device.\n\n${input.request.task}\n\n${input.context ? `Source thread context from ${input.context.sourceHostId}/${input.context.sourceThreadId} (read-only snapshot):\n${input.context.summary}\nAttachments: ${JSON.stringify(input.context.attachments.map((file) => ({ name: file.name, sha256: file.sha256, sourcePath: file.sourcePath })))}` : ""}`,
              },
            ],
          },
        });
        const creation = createEngineSession({
          ...context,
          send(reply) {
            if (reply.type === "commandResult" && reply.commandId === createId) {
              creations.delete(creation);
              const progress = context.options.workspaceActions?.creationDrafts.get(
                createId,
                owner,
              )?.progress;
              const retryable =
                reply.error?.includes("not_ready") ||
                reply.error?.includes("unavailable") ||
                [
                  "workspace_preparing",
                  "workspace_busy",
                  "thread_creation_in_progress",
                  "engine_capacity_exceeded",
                  "engine_starting",
                  "daemon_shutting_down",
                ].includes(reply.error ?? "");
              const safe =
                !store.getThread(input.threadId) &&
                !context.options.engine?.creationPending(input.threadId) &&
                progress?.cleanupComplete !== false;
              context.send({
                ...base,
                ok: reply.ok,
                ...(!reply.ok ? { error: "not_ready" as const } : {}),
                ...(reply.error === "remote_task_cancelled"
                  ? { phase: safe ? ("cancelled" as const) : ("cancelling" as const) }
                  : !reply.ok && safe && !retryable
                    ? { phase: "failed" as const }
                    : {}),
              });
            } else context.send(reply);
          },
        });
        creations.add(creation);
        await creation.command?.accept(command, owner);
        return true;
      }
      if (message.type === "delegation.remote.status") {
        if (!task || !thread) {
          context.send({ ...base, ok: false, error: "not_found" });
          return true;
        }

        const family =
          context.options.agentControl?.delegations.journal
            .family(thread.id)
            .map((edge) => edge.childId) ?? [];
        const ids = [thread.id, ...family];
        let usage = { tokens: 0, cost: 0 };
        if (context.options.usage?.sessionTotals)
          for (const threadId of ids) {
            const rows = await context.options.usage.sessionTotals({
              thread: threadId,
              limit: 100,
            });
            for (const row of rows)
              usage = {
                tokens: Math.min(
                  Number.MAX_SAFE_INTEGER,
                  usage.tokens +
                    row.inputTokens +
                    row.outputTokens +
                    row.cachedInputTokens +
                    row.cacheWriteTokens +
                    row.cacheWrite1hTokens,
                ),
                cost: usage.cost + row.costUsd,
              };
          }
        if (!context.connected() || !context.authorize("read")) return true;
        const current = store.getThread(thread.id);
        if (!current || current.deletedAt !== undefined || !context.canReadThread(thread.id)) {
          context.send({ ...base, ok: false, error: "not_found" });
          return true;
        }
        const status = current.status.state;
        const terminal = status === "done" || status === "failed";
        const outcome = terminal ? threadOutcome(store, current) : undefined;
        context.send({
          ...base,
          ok: true,
          usage,
          phase:
            status === "done"
              ? "completed"
              : status === "failed"
                ? "failed"
                : status === "working"
                  ? "running"
                  : "waiting",
          ...(outcome ? { result: outcome.result, truncated: outcome.truncated } : {}),
        });
        return true;
      }
      // The same task-owned receipt fences a delayed start, including another broker device.
      store.recordCommand(createId, owner, () => ({
        commandId: createId,
        ok: false,
        error: "remote_task_cancelled",
      }));
      let progress: Extract<ServerMessage, { type: "worktree.creation.result" }> | undefined;
      const control = createEngineSession({
        ...context,
        send(reply) {
          if (reply.type === "worktree.creation.result") progress = reply;
        },
      });
      await control.handle?.(
        {
          type: "worktree.creation.request",
          requestId: message.requestId,
          commandId: createId,
          action: "get",
        },
        owner,
      );
      if (progress?.ok && progress.progress) {
        const state = progress.progress;
        if (["running", "cancelling"].includes(state.state)) {
          await control.handle?.(
            {
              type: "worktree.creation.request",
              requestId: message.requestId,
              commandId: createId,
              action: "cancel",
            },
            owner,
          );
          context.send({ ...base, ok: true, phase: "cancelling" });
          return true;
        }
        if (!state.cleanupComplete) {
          context.send({ ...base, ok: true, phase: "cancelling" });
          return true;
        }
      }
      if (context.options.engine?.creationPending(ThreadId.parse(`remote-${id}`))) {
        context.send({ ...base, ok: true, phase: "cancelling" });
        return true;
      }
      if (!thread) {
        context.send({ ...base, ok: true, phase: "cancelled" });
        return true;
      }
      const commandId = CommandId.parse(`remote-stop:${id}`);
      let reply: import("@ace/protocol").CommandResult;
      try {
        reply = store.recordCommand(commandId, owner, () => {
          const result = context.options.engine?.internalHandler.handle(
            Command.parse({
              id: commandId,
              deviceId: owner,
              payload: { type: "thread.interrupt", threadId: thread.id, cascade: true },
            }),
            commandContext(store),
          ) ?? { commandId, ok: false, error: "engine_unavailable" };
          if (!result.ok) throw new Error("Remote interrupt unavailable");
          return result;
        });
      } catch {
        context.send({ ...base, ok: false, error: "not_ready" });
        return true;
      }
      if (!reply.ok) {
        context.send({ ...base, ok: false, error: "not_ready" });
        return true;
      }
      const state = store.getThread(thread.id)?.status.state;
      context.send({
        ...base,
        ok: true,
        phase: state === "done" || state === "failed" ? "cancelled" : "cancelling",
      });
      return true;
    },
  };
}
