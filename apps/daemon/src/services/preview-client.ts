import { logError } from "@ace/diagnostics";
import {
  PreviewErrorCode,
  type DeviceScope,
  type PreviewRequest,
  type ThreadId,
} from "@ace/protocol";
import { PreviewClient } from "../preview-client.ts";
import { hostPreviewIdentity } from "../preview.ts";
import { createPreviewSuggestions } from "../preview-suggestions/service.ts";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";
export function startPreviewClient({
  services,
  resources,
  onListen,
  store,
  now,
  log,
}: ServiceContext): void {
  const preview = new PreviewClient((id) => {
    const thread = store.getThread(id);
    return !!thread && thread.deletedAt === undefined;
  });
  const unsubscribe = store.subscribe((events) => {
    for (const event of events)
      if (
        event.payload.type === "thread.client.updated" &&
        event.payload.changes.deletedAt !== undefined
      )
        preview.releaseThread(event.threadId);
  });
  resources.own(unsubscribe);
  services.previewClient = preview;
  resources.own(() => preview.close());
  const daemonPorts = new Set<number>();
  const suggestions = createPreviewSuggestions({
    store,
    runtime: () => services.workspaceActions,
    now,
    daemonPorts: () => daemonPorts,
    onError: (error) => log.log("debug", "Dev server detection failed", logError(error)),
  });
  services.previewSuggestions = suggestions;
  resources.own(() => suggestions.close());
  onListen.push((server) => {
    if (server.preview) preview.bind(server.preview);
    daemonPorts.add(Number(new URL(server.httpUrl).port));
  });
}

/**
 * Listing reads; forwarding exposes a host port, so it stays trusted host control; a sign-in
 * link opens a session that may mutate the app, so it takes `operate` (ADR 0008).
 */
const scopes: Record<PreviewRequest["operation"]["op"], DeviceScope> = {
  list: "read",
  forward: "admin",
  unforward: "admin",
  link: "operate",
};

/** A refusal the client can explain; anything unexpected stays the generic code. */
function errorCode(error: unknown): PreviewErrorCode {
  const code = PreviewErrorCode.safeParse(error instanceof Error ? error.message : undefined);
  return code.success ? code.data : "preview_refused";
}

export function createPreviewClientSession({
  options,
  authorize,
  canReadThread,
  hostCredential,
  device,
  send,
  connected,
  sessionId,
}: SocketContext): SocketService {
  const tracker = options.previewSuggestions;
  /** The thread's detected dev servers, holding the thread for pushes while this socket asks. */
  const watch = (threadId: ThreadId) =>
    tracker
      ? tracker.watch(sessionId, threadId, (suggestions) => {
          if (connected() && authorize("read") && canReadThread(threadId))
            send({ type: "preview.suggestions", threadId, suggestions: [...suggestions] });
        })
      : Promise.resolve([]);
  return {
    close() {
      tracker?.release(sessionId);
    },
    async handle(message) {
      if (message.type !== "preview.request") return false;
      const { operation, threadId } = message;
      const result = { type: "preview.result" as const, requestId: message.requestId };
      if (!authorize(scopes[operation.op]) || !canReadThread(threadId)) {
        send({ ...result, ok: false, error: "forbidden" });
        return true;
      }
      // Detection needs no gateway: a client without one can still open a server directly.
      const suggestions =
        operation.op === "list" && operation.suggestions
          ? { suggestions: await watch(threadId) }
          : {};
      const preview = options.previewClient;
      if (!preview?.available) {
        send({ ...result, ok: false, error: "preview_unavailable", ...suggestions });
        return true;
      }
      try {
        if (operation.op === "link") {
          // The session is bound to who asked: the host credential, or this paired device,
          // whose revocation then ends the session too.
          const identity = hostCredential?.() ? hostPreviewIdentity : device();
          if (!identity) throw new Error("forbidden");
          const link = await preview.link(threadId, operation.port, identity);
          send({ ...result, ok: true, link });
          return true;
        }
        if (operation.op === "forward") preview.register(threadId, operation.port, "listener");
        if (operation.op === "unforward") preview.remove(threadId, operation.port);
        send({ ...result, ok: true, previews: preview.list(threadId), ...suggestions });
      } catch (error) {
        send({ ...result, ok: false, error: errorCode(error) });
      }
      return true;
    },
  };
}
