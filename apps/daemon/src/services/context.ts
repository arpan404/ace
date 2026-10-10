import { observeNativeImages, imageReference } from "../native-images.ts";
import { logError } from "@ace/diagnostics";
import { warmup } from "./warmup.ts";
import { contextScope } from "./context-scope.ts";
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
    ...(config.attachmentLimits ? { limits: config.attachmentLimits } : {}),
    now,
    id,
    threadExists: (threadId) => {
      const thread = store.getThread(ThreadId.parse(threadId));
      return thread !== undefined && thread.deletedAt === undefined;
    },
    retained: (thread, hash) => {
      const owner = store.getThread(ThreadId.parse(thread));
      return (
        owner !== undefined &&
        owner.deletedAt === undefined &&
        (store.nativeImages.retains(thread, hash) ||
          store.toolResults.retains(thread, hash) ||
          store.measurements.retains(thread, hash) ||
          (services.engine?.retainsAttachment(ThreadId.parse(thread), hash) ?? false))
      );
    },
    authorize: (_device, thread) => {
      const entity = store.getThread(ThreadId.parse(thread));
      return entity !== undefined && entity.deletedAt === undefined;
    },
    imageReference: (thread, reference, itemId) => {
      const path = imageReference(reference);
      return path ? store.nativeImages.resolve(thread, path, itemId) : undefined;
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
  resources.own(observeNativeImages(store, context, runtime.signal));
  const deletions = new Set<Promise<void>>();
  resources.own(() => Promise.all(deletions).then(() => {}));
  resources.own(
    store.subscribe((events) => {
      for (const event of events) {
        if (
          event.payload.type !== "thread.client.updated" ||
          event.payload.changes.deletedAt === undefined
        )
          continue;
        const cleanup = context.uploads
          .releaseThread(event.threadId)
          .then(() => context.uploads.collect())
          .then(() => {})
          .catch((error: unknown) =>
            log.log("error", "Deleted thread attachment cleanup failed", logError(error)),
          );
        deletions.add(cleanup);
        void cleanup.finally(() => deletions.delete(cleanup));
      }
    }),
  );
  void warmup(runtime, "context", () => context.uploads.ready);
  let pending: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const maintain = () => {
    if (pending) return;
    pending = context.uploads
      .collect()
      .then(() => {})
      .catch((error: unknown) => log.log("error", "Attachment maintenance failed", logError(error)))
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
  const { options, authorize, canReadThread, send, tasks, connected } = context;
  // At most eight bounded protocol requests wait on this socket. Chunk bodies are <=64 KiB.
  let pending = 0;
  let tail = Promise.resolve();
  return {
    async handle(message, device) {
      switch (message.type) {
        case "context.request": {
          const scope = contextScope(message.operation);
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
          if (!options.context || pending >= 8) {
            send({
              type: "context.result",
              requestId: message.requestId,
              result: {
                kind: "error",
                code: options.context ? "busy" : "unsupported",
                message: options.context
                  ? "Context request queue is full"
                  : "Context service unavailable",
              },
            });
            return true;
          }
          const service = options.context;
          pending++;
          const task = tail
            .then(() =>
              service.handle(
                device,
                message,
                (thread) =>
                  connected() &&
                  authorize(scope) &&
                  (thread === undefined || canReadThread(ThreadId.parse(thread))) &&
                  (!("threadId" in message.operation) || canReadThread(message.operation.threadId)),
              ),
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
              pending--;
            });
          tail = task;
          tasks.add(task);
          void task.finally(() => tasks.delete(task));
          return true;
        }
      }
      return false;
    },
  };
}
