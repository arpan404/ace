import { BrowserClientMessage, type BrowserServerMessage } from "@ace/protocol";
import type { BrowserService } from "./service.ts";

/** Caller supplies an authenticated connection and thread authorization. */
export function connectBrowser(
  service: BrowserService,
  options: {
    connectionId: string;
    authorize: (threadId: string, workspaceId?: string) => boolean;
    send: (message: BrowserServerMessage, serialized?: string) => boolean;
  },
): { handle(raw: unknown): Promise<void>; close(): void } {
  const subscriptions = new Map<string, () => void>();
  let pending = 0;
  let closed = false;
  return {
    async handle(raw) {
      const message = BrowserClientMessage.parse(raw);
      if (closed) return;
      const threadId =
        message.type === "browser.open" ? message.options.threadId : message.threadId;
      const respond = (result: unknown) => {
        if (!closed)
          options.send({ type: "browser.result", requestId: message.requestId, ok: true, result });
      };
      let counted = false;
      try {
        if (
          !options.authorize(
            threadId,
            message.type === "browser.open" ? message.options.workspaceId : undefined,
          )
        )
          throw new Error("Browser thread access denied");
        if (pending >= 32) throw new Error("Too many pending browser requests");
        pending++;
        counted = true;
        switch (message.type) {
          case "browser.open":
            respond(await service.open(message.options));
            break;
          case "browser.close":
            await service.closeThread(threadId);
            respond(null);
            break;
          case "browser.execute":
            respond(
              await service.execute(threadId, message.command, {
                kind: "human",
                connectionId: options.connectionId,
              }),
            );
            break;
          case "browser.input":
            await service.input(threadId, message.input, options.connectionId);
            respond(null);
            break;
          case "browser.takeover":
            respond(service.takeover(threadId, options.connectionId));
            break;
          case "browser.handback":
            respond(service.handback(threadId, options.connectionId));
            break;
          case "browser.subscribe": {
            subscriptions.get(threadId)?.();
            subscriptions.delete(threadId);
            if (subscriptions.size >= 8) throw new Error("Browser subscription limit");
            subscriptions.set(
              threadId,
              service.subscribe(
                threadId,
                options.connectionId,
                {
                  send: (frame) =>
                    options.send(
                      { type: "browser.frame", threadId: message.threadId, frame },
                      service.serializeFrame(threadId, frame),
                    ),
                },
                (state) => options.send({ type: "browser.state", state }),
              ),
            );
            respond(null);
            break;
          }
          case "browser.unsubscribe":
            subscriptions.get(threadId)?.();
            subscriptions.delete(threadId);
            respond(null);
            break;
          case "browser.ack":
            service.acknowledge(threadId, options.connectionId, message.sequence);
            break;
          case "browser.recording.start":
            await service.startRecording(threadId);
            respond(null);
            break;
          case "browser.recording.stop":
            respond(await service.stopRecording(threadId));
            break;
        }
      } catch (error) {
        if (!closed)
          options.send({
            type: "browser.result",
            requestId: message.requestId,
            ok: false,
            error: (error instanceof Error ? error.message : "Browser operation failed").slice(
              0,
              2048,
            ),
          });
      } finally {
        if (counted) pending--;
      }
    },
    close() {
      closed = true;
      for (const stop of subscriptions.values()) stop();
      subscriptions.clear();
      service.disconnect(options.connectionId);
    },
  };
}
