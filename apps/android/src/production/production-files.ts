import type { OneWayMessage, RequestOptions, ServiceRequest, ServiceResponse } from "@ace/client";
import type { ServerMessage } from "@ace/protocol";
import type { FilesClient } from "../files.ts";
import type { ReadingHandle } from "../runtime/production-startup.ts";
import type {
  ProductionFilesCancel,
  ProductionFilesRequest,
} from "../runtime/production-runtime.ts";

/**
 * The production thread's file viewer over the read-only handle.
 *
 * Mirrors the fixture thread's Files entry (a thread checkout's tree plus one
 * file at a time) without the raw client: every burst re-resolves the
 * exact-owner read handle (liveness plus binding pin, no grant check so the
 * viewer reads while view-only), the scope stays pinned to the open thread,
 * and the op allowlist in the runtime boundary refuses every mutation before
 * the socket. `send` only ever carries a download-channel cleanup; taps only
 * ever deliver file-change messages. Share/Quick Look stay out: `downloadCopy`
 * has no native share sheet behind it in this slice.
 */
export function productionFilesClient(handle: ReadingHandle, threadId: string): FilesClient {
  if (!threadId) throw new Error("A thread is required to browse its files.");
  return {
    get state() {
      try {
        return handle.connectionState().getSnapshot();
      } catch {
        return "connecting";
      }
    },
    connectionState: () => handle.connectionState(),
    request: async <Q extends ServiceRequest>(
      input: Q,
      options?: RequestOptions,
    ): Promise<ServiceResponse<Q>> => {
      assertThreadScope(input, threadId);
      return handle.filesRequest(input as unknown as ProductionFilesRequest, options) as Promise<
        ServiceResponse<Q>
      >;
    },
    send: (message: OneWayMessage) => {
      handle.filesSend(message as ProductionFilesCancel);
    },
    onMessage: (listener: (message: ServerMessage) => void) => handle.observeFiles(listener),
    cachedThread: (id: string) => handle.cachedThread(id),
  };
}

/** The viewer only reads its own thread's checkout: no project scopes, no other threads. */
function assertThreadScope(input: ServiceRequest, threadId: string): void {
  if (input.type === "files.pull") return;
  if (input.type === "files.request") {
    const scoped = input as { threadId?: unknown; workspaceId?: unknown; scope?: unknown };
    if (
      scoped.threadId === threadId &&
      scoped.workspaceId === undefined &&
      scoped.scope === undefined
    )
      return;
  } else if (input.type === "workspace.request") {
    const operation = (input as { operation?: { threadId?: unknown } }).operation;
    if (operation?.threadId === threadId) return;
  }
  throw new Error("This viewer only reads its own thread's checkout.");
}
