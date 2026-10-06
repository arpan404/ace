import { z } from "zod";
import { privateBrowserOwnership } from "../browser-private.ts";
import { browserArtifactAccess } from "../browser-artifacts.ts";
import { BrowserApprovals } from "../browser-approvals.ts";
import { BrowserOrigins } from "../browser-origins.ts";
import { BrowserService } from "@ace/browser";
import {
  ItemId,
  PermissionMode,
  BrowserOrigin,
  ThreadId,
  BrowserBackendClientMessage,
  BrowserBackendPreference,
  BrowserBackendLossPolicy,
} from "@ace/protocol";
import { InteractionId as importInteractionId } from "@ace/protocol";
import { desktopCredential } from "../browser-desktop.ts";
import { settingsScope } from "../settings.ts";
import type { ServiceContext } from "./types.ts";
export async function startBrowser(context: ServiceContext): Promise<void> {
  const { config, options, store, now, id, resources, services } = context;

  await desktopCredential(config.dataDir, store.devices, now);
  const origins = new BrowserOrigins({
    store,
    now,
    id,
    mode: async (threadId) =>
      services.engine?.permissionAuthority(threadId) ??
      store.getThread(threadId)?.permission?.effective ??
      PermissionMode.parse(
        (
          await services.settings?.get(
            "permissions.defaultMode",
            settingsScope(store, { threadId }),
          )
        )?.value ?? "auto-review",
      ),
    deferRecovery: true,
    root: (threadId) => services.engine?.rootAgent(threadId),
    open: (interaction) => {
      if (!services.engine) {
        store.appendEvents(
          interaction.threadId,
          [{ type: "interaction.opened", interaction }],
          now(),
        );
        return interaction;
      }
      const raw = interaction.raw.find((entry) => entry.type === "ace.browser.origin");
      const key = z
        .object({ key: z.string() })
        .parse(raw && "data" in raw ? raw.data : undefined).key;
      const interactionId = services.engine.openHostApproval(
        interaction.threadId,
        key,
        interaction.request,
        interaction.raw,
      );
      const opened = store.getInteraction(interactionId);
      if (!opened) throw new Error("Browser approval unavailable");
      return opened;
    },
    closeInteraction: (threadId, interactionId, result) => {
      if (!services.engine) {
        store.appendEvents(
          threadId,
          [{ type: "interaction.closed", interactionId, closedAt: now(), ...result }],
          now(),
        );
        return;
      }
      const raw = store
        .getInteraction(interactionId)
        ?.raw.find((entry) => entry.type === "ace.browser.origin");
      const key = z
        .object({ key: z.string() })
        .parse(raw && "data" in raw ? raw.data : undefined).key;
      services.engine.resolveHostApproval(threadId, key, result);
    },
    allowlist: async () =>
      BrowserOrigin.array()
        .max(256)
        .parse((await services.settings?.get("browser.allowedOrigins", {}))?.value ?? []),
  });
  services.browserOrigins = origins;
  resources.own(() => origins.close());
  resources.onShutdown(() => origins.close());
  const approvals = new BrowserApprovals(
    {
      store,
      now,
      id,
      mode: async (threadId) =>
        services.engine?.permissionAuthority(threadId) ??
        store.getThread(threadId)?.permission?.effective ??
        PermissionMode.parse(
          (
            await services.settings?.get(
              "permissions.defaultMode",
              settingsScope(store, { threadId }),
            )
          )?.value ?? "auto-review",
        ),
      root: (threadId) =>
        services.engine?.rootAgent(threadId) ?? store.getThread(threadId)?.rootAgentId,
      open: (interaction) => {
        if (services.engine) {
          const raw = interaction.raw.find((entry) => entry.type === "ace.browser.permission");
          const key = z
            .object({ key: z.string() })
            .parse(raw && "data" in raw ? raw.data : undefined).key;
          const interactionId = services.engine.openHostApproval(
            interaction.threadId,
            key,
            interaction.request,
            interaction.raw,
          );
          const opened = store.getInteraction(interactionId);
          if (!opened) throw new Error("Browser approval unavailable");
          return opened;
        }
        store.appendEvents(
          interaction.threadId,
          [{ type: "interaction.opened", interaction }],
          now(),
        );
        return interaction;
      },
      close: (threadId, key, result, rawInteractionId) => {
        if (services.engine) services.engine.resolveHostApproval(threadId, key, result);
        else {
          const interactionId = importInteractionId.parse(rawInteractionId);
          if (interactionId)
            store.appendEvents(
              threadId,
              [{ type: "interaction.closed", interactionId, closedAt: now(), ...result }],
              now(),
            );
        }
      },
    },
    options.browser?.navigationClock ?? {
      set: (delay, work) => {
        const timer = setTimeout(work, delay);
        return () => clearTimeout(timer);
      },
    },
  );
  services.browserApprovals = approvals;
  resources.own(() => approvals.close());
  resources.onShutdown(() => approvals.close());
  const browser = new BrowserService({
    ...options.browser,
    dataDir: config.dataDir,
    originPolicy: (request) => origins.allowed(request),
    origins,
    ...privateBrowserOwnership(context),
    evaluatePolicy:
      options.browser?.evaluatePolicy ??
      ((threadId, url, signal, mode, expression) =>
        approvals.evaluate(threadId, url, signal, mode, expression)),
    evaluateGrants: approvals,
    downloadPolicy:
      options.browser?.downloadPolicy ??
      ((threadId, url, signal) => approvals.downloads(threadId, url, signal)),
    uploadPolicy:
      options.browser?.uploadPolicy ??
      ((threadId, paths, signal) => approvals.upload(threadId, paths, signal)),
    artifactAllowed: options.browser?.artifactAllowed ?? browserArtifactAccess(store),
    workspaceRoot:
      options.browser?.workspaceRoot ??
      ((threadId) => {
        const binding = store.executionWorkspace(ThreadId.parse(threadId));
        if (!binding.ready) throw new Error("workspace_preparing");
        return binding.path;
      }),
    onNavigation: (threadId) => origins.clearPage(threadId),
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
  if (services.engine || options.handler) {
    origins.recover();
    approvals.recover();
  }
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
