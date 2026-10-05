import { BrowserOriginError } from "./policy.ts";
import { ThreadId, BrowserClientMessage, type BrowserServerMessage } from "@ace/protocol";
import type { BrowserService } from "./service.ts";

function requiredAccess(message: BrowserClientMessage): "read" | "operate" {
  if (["browser.subscribe", "browser.unsubscribe", "browser.ack"].includes(message.type))
    return "read";
  if (
    message.type === "browser.execute" &&
    ["snapshot", "screenshot", "logs", "wait_for"].includes(message.command.action)
  )
    return "read";
  return "operate";
}

/** Caller supplies an authenticated connection and thread authorization. */
export function connectBrowser(
  service: BrowserService,
  options: {
    connectionId: string;
    authorize: (
      threadId: string,
      workspaceId: string | undefined,
      access: "read" | "operate",
    ) => boolean;
    send: (message: BrowserServerMessage, serialized?: string) => boolean;
  },
): { handle(raw: unknown): Promise<void>; close(): void } {
  type Subscription = { stop(): void; subscribers: Set<string> };
  const subscriptions = new Map<string, Subscription>();
  const bind = (threadId: string, entry: Subscription) => {
    entry.stop = service.subscribe(
      threadId,
      options.connectionId,
      {
        send: (frame) =>
          options.send(
            { type: "browser.frame", threadId: ThreadId.parse(threadId), frame },
            service.serializeFrame(threadId, frame),
          ),
      },
      (state) => options.send({ type: "browser.state", state }),
      (event) => options.send(event),
    );
  };
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
            requiredAccess(message),
          )
        )
          throw new Error("Browser thread access denied");
        if (pending >= 32) throw new Error("Too many pending browser requests");
        pending++;
        counted = true;
        switch (message.type) {
          case "browser.origins.list":
            respond(service.originsList(threadId));
            break;
          case "browser.origins.grant":
            service.originsGrant(threadId, message.origin);
            respond(service.originsList(threadId));
            break;
          case "browser.origins.revoke":
            service.originsRevoke(threadId, message.origin);
            respond(service.originsList(threadId));
            break;
          case "browser.open": {
            const stopProgress = service.downloadProgress((progress) => {
              if (!closed) options.send(progress);
            });
            try {
              const state = await service.open(message.options);
              respond(state);
            } finally {
              stopProgress();
            }
            break;
          }
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
            const subscriber = message.subscriberId ?? "legacy";
            let entry = subscriptions.get(threadId);
            if (entry) {
              if (entry.subscribers.size >= 64 && !entry.subscribers.has(subscriber))
                throw new Error("Browser subscriber limit");
              options.send({ type: "browser.state", state: service.state(threadId) });
              service.replayFrame(threadId, options.connectionId);
              entry.subscribers.add(subscriber);
            } else {
              if (subscriptions.size >= 8) throw new Error("Browser subscription limit");
              entry = { subscribers: new Set([subscriber]), stop() {} };
              bind(threadId, entry);
              subscriptions.set(threadId, entry);
            }
            respond(null);
            break;
          }
          case "browser.unsubscribe": {
            const entry = subscriptions.get(threadId);
            entry?.subscribers.delete(message.subscriberId ?? "legacy");
            if (entry && !entry.subscribers.size) {
              entry.stop();
              subscriptions.delete(threadId);
            }
            respond(null);
            break;
          }
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
            ...(error instanceof BrowserOriginError ? { blocked: error.blocked } : {}),
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
      for (const entry of subscriptions.values()) entry.stop();
      subscriptions.clear();
      service.disconnect(options.connectionId);
    },
  };
}
