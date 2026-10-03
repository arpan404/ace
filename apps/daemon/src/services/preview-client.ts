import { PreviewClient } from "../preview-client.ts";
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
export function createPreviewClientSession({
  options,
  authorize,
  canReadThread,
  send,
}: SocketContext): SocketService {
  return {
    handle(message) {
      if (message.type !== "preview.request") return false;
      const scope = message.operation.op === "list" ? "read" : "admin";
      const result = { type: "preview.result" as const, requestId: message.requestId };
      if (!authorize(scope) || !canReadThread(message.threadId)) {
        send({ ...result, ok: false, error: "forbidden" });
        return true;
      }
      const preview = options.previewClient;
      if (!preview?.available) {
        send({ ...result, ok: false, error: "preview_unavailable" });
        return true;
      }
      try {
        if (message.operation.op === "forward")
          preview.register(message.threadId, message.operation.port, "listener");
        if (message.operation.op === "unforward")
          preview.remove(message.threadId, message.operation.port);
        send({ ...result, ok: true, previews: preview.list(message.threadId) });
      } catch {
        send({ ...result, ok: false, error: "preview_refused" });
      }
      return true;
    },
  };
}
