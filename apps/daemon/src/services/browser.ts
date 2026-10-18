import { settingsScope } from "../settings.ts";
import { z } from "zod";
import { join } from "node:path";
import { BrowserService, UserChromeTabsBackend, type BrowserServiceOptions } from "@ace/browser";
import {
  ItemId,
  ThreadId,
  BrowserBackendClientMessage,
  BrowserBackendPreference,
  BrowserBackendLossPolicy,
} from "@ace/protocol";
import { desktopCredential } from "../browser-desktop.ts";
import { BrowserForget } from "../browser-forget.ts";
import { SqliteBrowserTabStore } from "../browser-tab-store.ts";
import type { ServiceContext } from "./types.ts";
const BrowserProfilePreference = z.enum(["persistent", "ephemeral"]);
export async function startBrowser(context: ServiceContext): Promise<void> {
  const { config, options, store, now, id, resources, services } = context;

  await desktopCredential(config.dataDir, store.devices, now);
  let forget: BrowserForget | undefined;
  const workspaceRoot: BrowserServiceOptions["workspaceRoot"] =
    options.browser?.workspaceRoot ??
    ((threadId) => {
      const binding = store.executionWorkspace(ThreadId.parse(threadId));
      if (!binding.ready) throw new Error("workspace_preparing");
      return binding.path;
    });
  const onArtifact: BrowserServiceOptions["onArtifact"] = async (rawThreadId, artifact) => {
    const threadId = ThreadId.parse(rawThreadId);
    const thread = store.getThread(threadId);
    if (!thread || thread.deletedAt !== undefined) return;
    const files = services.threadFiles;
    const append = (artifactId?: string) =>
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
            ...(artifactId ? { artifactId } : {}),
          },
        },
      ]);
    if (files) await files.browserArtifacts.publish(threadId, artifact, append);
    else append();
  };
  const browser = new BrowserService({
    ...options.browser,
    dataDir: config.dataDir,
    tabStore: options.browser?.tabStore ?? new SqliteBrowserTabStore((sql) => store.statement(sql)),
    workspaceRoot,
    cleanup: {
      ...options.browser?.cleanup,
      onTimeout(message) {
        context.log.log("warn", message);
        options.browser?.cleanup?.onTimeout?.(message);
      },
    },
    now,
    id,
    backendPreference:
      options.browser?.backendPreference ??
      (async (open) => {
        const preference = BrowserBackendPreference.parse(
          (
            await services.settings?.get(
              "browser.backend",
              settingsScope(store, { threadId: open.threadId, workspaceId: open.workspaceId }),
            )
          )?.value ?? "auto",
        );
        return preference;
      }),
    profilePreference:
      options.browser?.profilePreference ??
      (async (open) =>
        BrowserProfilePreference.parse(
          (
            await services.settings?.get(
              "browser.profile",
              settingsScope(store, { threadId: open.threadId, workspaceId: open.workspaceId }),
            )
          )?.value ?? "persistent",
        )),
    onEmbeddedRegistered: () => {
      void forget?.flush().catch((error: unknown) => context.log.log("warn", String(error)));
      options.browser?.onEmbeddedRegistered?.();
    },
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
    onArtifact,
    agentCursor: options.browser?.agentCursor ?? {
      // A subagent's cursor carries its name; the thread's own agent is just "Agent".
      name: (threadId, agentId) => {
        const thread = ThreadId.safeParse(threadId);
        if (!agentId || !thread.success) return undefined;
        const agent = store.getMcpAgent(thread.data, agentId);
        return agent && agent.origin !== "root" ? (agent.name ?? agent.role) : undefined;
      },
    },
    userChromeStorageReads:
      options.browser?.userChromeStorageReads ??
      (async (threadId) => {
        try {
          const setting = await services.settings?.get(
            "browser.userChrome.storageReads",
            settingsScope(store, { threadId: ThreadId.parse(threadId) }),
          );
          return setting?.value === true;
        } catch {
          // An unknown thread or unreadable settings keep the person's storage closed.
          return false;
        }
      }),
  });
  resources.own(() => browser.close());
  const user = services.userBrowser;
  if (user) {
    // The person's own Chrome (ADR 0084): no desktop views, no restore, no fallback. A lost
    // tab or browser closes the thread's session there; it never moves to ace's own browser.
    const sessions = new BrowserService({
      dataDir: join(config.dataDir, "user-browser", "threads"),
      headlessBackend: new UserChromeTabsBackend(user.backend),
      backendPreference: () => "headless",
      tabLifecycle: false,
      now,
      id,
      workspaceRoot,
      onArtifact,
    });
    resources.own(() => sessions.close());
    services.userBrowserSessions = sessions;
  }
  forget = new BrowserForget(store, browser, (error) =>
    context.log.log("warn", `Browser cleanup for a deleted thread: ${String(error)}`),
  );
  resources.own(() => forget?.close());
  services.browser = browser;
}

import { sendBrowserMessage } from "./browser-transport.ts";
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
    local: context.local ?? false,
    authorize: (threadId, workspaceId, access) => {
      const id = ThreadId.parse(threadId);
      const thread = options.store.getThread(id);
      return (
        thread !== undefined &&
        thread.deletedAt === undefined &&
        authorize(access) &&
        canReadThread(id) &&
        (workspaceId === undefined || thread.workspaceId === workspaceId)
      );
    },
    send: (message, serialized) => sendBrowserMessage(socket, message, serialized),
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
