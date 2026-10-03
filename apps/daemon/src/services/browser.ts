import { BrowserService } from "@ace/browser";
import {
  ItemId,
  ThreadId,
  BrowserBackendClientMessage,
  BrowserBackendPreference,
  BrowserBackendLossPolicy,
} from "@ace/protocol";
import { desktopCredential } from "../browser-desktop.ts";
import { settingsScope } from "../settings.ts";
import type { ServiceContext } from "./types.ts";
export async function startBrowser(context: ServiceContext): Promise<void> {
  const { config, options, store, now, id, resources, services } = context;

  await desktopCredential(config.dataDir, store.devices, now);
  const browser = new BrowserService({
    ...options.browser,
    dataDir: config.dataDir,
    now,
    id,
    backendPreference:
      options.browser?.backendPreference ??
      (async (open) =>
        BrowserBackendPreference.parse(
          (
            await services.settings?.get(
              "browser.backend",
              settingsScope(store, { threadId: open.threadId, workspaceId: open.workspaceId }),
            )
          )?.value ?? "auto",
        )),
    backendLoss:
      options.browser?.backendLoss ??
      (async (open) =>
        BrowserBackendLossPolicy.parse(
          (
            await services.settings?.get(
              "browser.backendLoss",
              settingsScope(store, { threadId: open.threadId, workspaceId: open.workspaceId }),
            )
          )?.value ?? "pause",
        )),
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
  let backend: import("@ace/browser").EmbeddedBackend | undefined;
  let stopRevocation: (() => void) | undefined;
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
      stopRevocation?.();
      backend?.disconnect("Desktop app disconnected");
      browser.close();
    },
    handle(message, device) {
      const backendMessage = BrowserBackendClientMessage.safeParse(message);
      if (backendMessage.success) {
        try {
          if (backendMessage.data.type === "browser.backend.register") {
            const credential = options.store.devices.authenticate(
              backendMessage.data.credential,
              options.now?.() ?? Date.now(),
            );
            if (
              !authorize("admin") ||
              credential?.id !== device ||
              !credential.scopes.includes("desktop")
            )
              throw new Error("Local desktop-scoped credential required");
            if (backend) throw new Error("Desktop backend already registered on this connection");
            backend = options.browser?.registerEmbedded({
              send: (outgoing, serialized) => {
                if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 256 * 1024)
                  return false;
                socket.send(serialized ?? JSON.stringify(outgoing));
                return true;
              },
              close: (reason) => socket.close(4009, reason.slice(0, 120)),
            });
            stopRevocation = options.store.devices.onRevoke((id) => {
              if (id === device) backend?.disconnect("Desktop credential revoked");
            });
            socket.send(
              JSON.stringify({
                type: "browser.backend.registered",
                requestId: backendMessage.data.requestId,
                backendId: backend?.id,
                connectionId: sessionId,
              }),
            );
          } else {
            if (!backend) throw new Error("Desktop backend not registered");
            backend.handle(backendMessage.data);
          }
        } catch (error) {
          context.fail(
            "browser_backend_denied",
            error instanceof Error ? error.message : "Desktop registration failed",
          );
        }
        return true;
      }
      if (!message.type.startsWith("browser.")) return false;
      const parsed = importBrowserMessage.safeParse(message);
      if (!parsed.success) return false;
      void browser.handle(parsed.data).catch((error: unknown) => options.log?.(error));
      return true;
    },
  };
}
import { BrowserClientMessage as importBrowserMessage } from "@ace/protocol";
