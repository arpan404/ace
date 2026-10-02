import { BrowserService } from "@ace/browser";
import { ItemId, ThreadId } from "@ace/protocol";
import type { ServiceContext } from "./types.ts";
export async function startBrowser(context: ServiceContext): Promise<void> {
  const { config, options, store, now, id, resources, services } = context;

  const browser = new BrowserService({
    ...options.browser,
    dataDir: config.dataDir,
    onArtifact: (rawThreadId, artifact) => {
      const threadId = ThreadId.parse(rawThreadId);
      const thread = store.getThread(threadId);
      if (!thread) throw new Error("Recording thread no longer exists");
      store.appendEvents(threadId, [
        {
          type: "item.created",
          item: {
            type: "artifact",
            id: ItemId.parse(id()),
            ...(thread.rootAgentId ? { agentId: thread.rootAgentId } : {}),
            createdAt: now(),
            complete: true,
            source: "browser",
            ...artifact,
          },
        },
      ]);
    },
  });
  resources.own(() => browser.close());
  services.browser = browser;
}

import { connectBrowser } from "@ace/browser";
import { WebSocket } from "ws";
import type { SocketContext, SocketService } from "./socket.ts";
export function createBrowserSession(context: SocketContext): SocketService {
  const { options, socket, sessionId, authorize, canReadThread } = context;
  if (!options.browser) return {};
  const browser = connectBrowser(options.browser, {
    connectionId: sessionId,
    authorize: (threadId, workspaceId, access) => {
      const id = ThreadId.parse(threadId);
      const thread = options.store.getThread(id);
      return (
        thread !== undefined &&
        authorize(access) &&
        canReadThread(id) &&
        (workspaceId === undefined || thread.workspaceId === workspaceId)
      );
    },
    send: (message, serialized) => {
      if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 256 * 1024) {
        if (message.type !== "browser.frame") socket.close(4009, "Browser transport backpressure");
        return false;
      }
      socket.send(serialized ?? JSON.stringify(message));
      return true;
    },
  });
  return {
    close() {
      browser.close();
    },
    handle(message) {
      if (!message.type.startsWith("browser.")) return false;
      const parsed = importBrowserMessage.safeParse(message);
      if (!parsed.success) return false;
      void browser.handle(parsed.data).catch((error: unknown) => options.log?.(error));
      return true;
    },
  };
}
import { BrowserClientMessage as importBrowserMessage } from "@ace/protocol";
