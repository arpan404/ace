import { retainsHtml } from "../html-publication.ts";
import { retainsImage } from "../image-publication.ts";
import { observeNativeImages, imageReference } from "../native-images.ts";
import { logError } from "@ace/diagnostics";
import { warmup } from "./warmup.ts";
import { contextScope } from "./context-scope.ts";
import { aceFilesIo } from "../files-tool/io.ts";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { ContextError, ContextService, summarizeThreadReference } from "@ace/context";
import { ThreadId, WorkspaceId } from "@ace/protocol";
import type { ServiceContext } from "./types.ts";
import { backgroundFailure } from "./background.ts";
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
        (retainsHtml(store, thread, hash) ||
          retainsImage(store, thread, hash) ||
          store.nativeImages.retains(thread, hash) ||
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
        store.readBoundedItemPage(target.id, store.headSeq() + 1, 20, 32768),
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
    complete: async (root, query, limit) => {
      const native = services.filesNative;
      if (!native)
        throw new ContextError(
          "unsupported",
          "Quick open needs ace-files, which this machine does not have yet",
        );
      try {
        return await native.tool.quickOpen(root, query, limit);
      } catch (error) {
        const code = error instanceof Error && "code" in error ? String(error.code) : "";
        throw new ContextError(
          code === "FILES_RESTARTING" || code === "BUSY" ? "busy" : "unsupported",
          describeFailure(error),
        );
      }
    },
    listFolder: (root, folder) => {
      const native = services.filesNative;
      if (!native)
        throw new ContextError(
          "unsupported",
          "Folder mentions need ace-files, which this machine does not have yet",
        );
      return contextFiles(native.tool, root, folder);
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
          .then(() => context.uploads.expire())
          .then(() => {})
          .catch((error: unknown) =>
            log.log("error", "Deleted thread attachment cleanup failed", logError(error)),
          );
        deletions.add(cleanup);
        // The cleanup reports its own failure above; this only forgets it.
        void cleanup.finally(() => deletions.delete(cleanup)).catch(() => {});
      }
    }),
  );
  // The warmup logs its own failure and reports the status.
  void warmup(runtime, "context", () => context.uploads.ready).catch(() => {});
  let pending: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const maintain = () => {
    if (pending) return;
    pending = Promise.resolve()
      .then(() => context.uploads.expire())
      .then(() => {})
      .catch(backgroundFailure(runtime, "Attachment maintenance failed"))
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

import type { FilesTool } from "../files-tool/tool.ts";
import type { WorkspaceFileEntry } from "@ace/context";
import type { SocketContext, SocketService } from "./socket.ts";

/** A folder mention's files: ace-files' paged listing, with ignored entries left out. */
async function* contextFiles(
  tool: FilesTool,
  root: string,
  folder: string,
): AsyncGenerator<WorkspaceFileEntry> {
  for await (const entry of aceFilesIo(tool).walk(root, folder))
    if (entry.type === "file" && !entry.ignored)
      yield { path: entry.path, size: entry.size };
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
          const requestId = message.requestId;
          const thread = "threadId" in message.operation ? message.operation.threadId : undefined;
          /**
           * The live check the TypeScript service gets for every request. A queue, a quick-open
           * walk and the reply itself all cross awaits, so a socket that closed, a device whose
           * grant was revoked or a thread that stopped being readable must be asked again each
           * time, not only when the message arrived.
           */
          const allowed = () =>
            connected() &&
            authorize(scope) &&
            (thread === undefined || canReadThread(ThreadId.parse(thread)));
          const refuse = () =>
            send({
              type: "context.result",
              requestId,
              result: { kind: "error", code: "forbidden", message: `${scope} scope required` },
            });
          if (!allowed()) {
            refuse();
            return true;
          }
          if (!options.context || pending >= 8) {
            send({
              type: "context.result",
              requestId,
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
            .then(async () => {
              // The queue can hold a request while its socket closes or its device loses the
              // grant: nothing starts for a request that may no longer have its answer.
              if (!allowed()) {
                refuse();
                return;
              }
              send(
                await service.handle(
                  device,
                  message,
                  (wanted) =>
                    allowed() && (wanted === undefined || canReadThread(ThreadId.parse(wanted))),
                ),
              );
            })
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
          // The task answers its own failure above; this only forgets it.
          void task.finally(() => tasks.delete(task)).catch(() => {});
          return true;
        }
      }
      return false;
    },
  };
}
