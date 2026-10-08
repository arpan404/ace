import { PreviewErrorCode, type DeviceScope, type PreviewRequest } from "@ace/protocol";
import { PreviewClient } from "../preview-client.ts";
import { hostPreviewIdentity } from "../preview.ts";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";
export function startPreviewClient({ services, resources, onListen }: ServiceContext): void {
  const preview = new PreviewClient();
  services.previewClient = preview;
  resources.own(() => preview.close());
  onListen.push((server) => {
    if (server.preview) preview.bind(server.preview);
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
}: SocketContext): SocketService {
  return {
    async handle(message) {
      if (message.type !== "preview.request") return false;
      const { operation, threadId } = message;
      const result = { type: "preview.result" as const, requestId: message.requestId };
      if (!authorize(scopes[operation.op]) || !canReadThread(threadId)) {
        send({ ...result, ok: false, error: "forbidden" });
        return true;
      }
      const preview = options.previewClient;
      if (!preview?.available) {
        send({ ...result, ok: false, error: "preview_unavailable" });
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
        send({ ...result, ok: true, previews: preview.list(threadId) });
      } catch (error) {
        send({ ...result, ok: false, error: errorCode(error) });
      }
      return true;
    },
  };
}
