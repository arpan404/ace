import { warmup } from "./warmup.ts";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { ContextService, summarizeThreadReference } from "@ace/context";
import { ThreadId, WorkspaceId } from "@ace/protocol";
import type { ServiceContext } from "./types.ts";
export async function startContext(runtime: ServiceContext): Promise<void> {
  const { config, store, now, id, resources, services, log, onListen } = runtime;

  const context = await ContextService.open({
    signal: runtime.signal,
    root: join(config.dataDir, "context"),
    now,
    id,
    retained: (thread, hash) =>
      services.engine?.retainsAttachment(ThreadId.parse(thread), hash) ?? false,
    authorize: (_device, thread) => {
      const entity = store.getThread(ThreadId.parse(thread));
      return entity !== undefined && entity.deletedAt === undefined;
    },
    workspaceRoot: async (workspaceId) => {
      const path = store.getWorkspacePath(WorkspaceId.parse(workspaceId));
      return path ? realpath(path) : undefined;
    },
    async threadReference(_device, owner, reference) {
      const source = store.getThread(ThreadId.parse(owner));
      const target = store.getThread(reference.threadId);
      const journal = services.agentControl?.delegations.journal;
      const family =
        source &&
        journal &&
        (journal.get(source.id)?.rootId ?? source.id) ===
          (journal.get(reference.threadId)?.rootId ?? reference.threadId);
      if (
        !source ||
        source.deletedAt !== undefined ||
        !target ||
        target.deletedAt !== undefined ||
        (target.workspaceId !== source.workspaceId && !family)
      )
        throw new Error("Thread context access denied");
      return summarizeThreadReference(
        reference,
        target,
        store.readItemPage(target.id, store.headSeq() + 1, 20, 32768),
      );
    },
    threadWorkspaceRoot: async (thread) => {
      const entity = store.getThread(ThreadId.parse(thread));
      const path = entity ? store.getWorkspacePath(entity.workspaceId) : undefined;
      return path ? realpath(path) : undefined;
    },
    workspace: async (thread) => {
      const threadId = ThreadId.parse(thread);
      if (!store.getThread(threadId)) return undefined;
      const binding = store.executionWorkspace(threadId);
      return binding.ready ? realpath(binding.path) : undefined;
    },
  });
  resources.own(() => context.close());
  services.context = context;
  void warmup(runtime, "context", () => context.uploads.ready);
  let pending: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const maintain = () => {
    if (pending) return;
    pending = context.uploads
      .collect()
      .then(() => {})
      .catch((error: unknown) => log.log("error", "Attachment maintenance failed", error))
      .finally(() => {
        pending = undefined;
      });
  };
  resources.own(async () => {
    if (timer) clearInterval(timer);
    await pending;
  });
  onListen.push(() => {
    maintain();
    timer = setInterval(maintain, 60_000);
    timer.unref();
  });
}

import type { SocketContext, SocketService } from "./socket.ts";
export function createContextSession(context: SocketContext): SocketService {
  const { options, authorize, canReadThread, send, tasks } = context;
  let contextBusy = false;
  return {
    async handle(message, device) {
      switch (message.type) {
        case "context.request": {
          const op = message.operation.op;
          const scope =
            op === "attachment.list" ||
            op === "attachment.read" ||
            op === "upload.status" ||
            op.startsWith("mention.") ||
            op === "draft.mention.complete"
              ? "read"
              : "operate";
          if (
            !authorize(scope) ||
            ("threadId" in message.operation && !canReadThread(message.operation.threadId))
          ) {
            send({
              type: "context.result",
              requestId: message.requestId,
              result: { kind: "error", code: "forbidden", message: `${scope} scope required` },
            });
            return true;
          }
          if (!options.context || contextBusy) {
            send({
              type: "context.result",
              requestId: message.requestId,
              result: {
                kind: "error",
                code: options.context ? "busy" : "unsupported",
                message: options.context
                  ? "Wait for the previous context result"
                  : "Context service unavailable",
              },
            });
            return true;
          }
          contextBusy = true;
          const task = options.context
            .handle(
              device,
              message,
              () =>
                authorize(scope) &&
                (!("threadId" in message.operation) || canReadThread(message.operation.threadId)),
            )
            .then(send)
            .catch((error: unknown) => {
              options.log?.(error);
              send({
                type: "context.result",
                requestId: message.requestId,
                result: {
                  kind: "error",
                  code: "invalid_request",
                  message: "Context operation failed",
                },
              });
            })
            .finally(() => {
              contextBusy = false;
            });
          tasks.add(task);
          void task.finally(() => tasks.delete(task));
          return true;
        }
      }
      return false;
    },
  };
}
