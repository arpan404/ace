import { settingsScope } from "../settings.ts";
import { z } from "zod";
import { join } from "node:path";
import {
  BrowserService,
  TabBudget,
  UserChromeTabsBackend,
  daemonTabLimit,
  type BrowserServiceOptions,
} from "@ace/browser";
import {
  ItemId,
  ThreadId,
  BrowserBackendClientMessage,
  BrowserBackendPreference,
  BrowserBackendLossPolicy,
} from "@ace/protocol";
import { desktopCredential } from "../browser-desktop.ts";
import { daemonDownloadFolder, downloadsHost } from "../download-folder.ts";
import { BrowserForget } from "../browser-forget.ts";
import { chooseProfileScope, projectProfileScope } from "../browser-profile-scope.ts";
import { BrowserProjectForget } from "../browser-forget-projects.ts";
import { SqliteBrowserTabStore } from "../browser-tab-store.ts";
import { watchBrowserTurns, type BrowserTurnPort } from "../browser-turns.ts";
import type { ServiceContext } from "./types.ts";
const BrowserProfilePreference = z.enum(["persistent", "ephemeral"]);
export async function startBrowser(context: ServiceContext): Promise<void> {
  const { config, options, store, now, id, resources, services } = context;

  await desktopCredential(config.dataDir, store.devices, now);
  let forget: BrowserForget | undefined;
  let projectForget: BrowserProjectForget | undefined;
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
  // ace's Chrome, the desktop's views and the person's own Chrome share one daemon-wide budget.
  const tabBudget = new TabBudget(options.browser?.maxTabs ?? daemonTabLimit);
  const browser = new BrowserService({
    ...options.browser,
    ...(config.chromiumPath && !options.browser?.executablePath
      ? { executablePath: config.chromiumPath }
      : {}),
    ...(config.chromiumNoSandbox ? { sandbox: false } : {}),
    // Why ace's browser would not start (a missing library, a blocked sandbox) is in the log.
    onError(error) {
      context.log.log(
        "warn",
        `ace's browser: ${error instanceof Error ? error.message : String(error)}`,
      );
      options.browser?.onError?.(error);
    },
    tabBudget,
    dataDir: config.dataDir,
    tabStore: options.browser?.tabStore ?? new SqliteBrowserTabStore((sql) => store.statement(sql)),
    // A fork (not a delegated thread) starts its browser with a copy of its parent's tabs.
    forkedFrom:
      options.browser?.forkedFrom ??
      ((threadId) => {
        const thread = store.getThread(ThreadId.parse(threadId));
        return thread && !thread.delegatedBy ? thread.lineage?.parentThreadId : undefined;
      }),
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
    // A project's choice in Edit project comes before the setting; a thread's own setting first.
    profileScope:
      options.browser?.profileScope ??
      (async (open) =>
        chooseProfileScope(
          await services.settings?.get(
            "browser.profileScope",
            settingsScope(store, { threadId: open.threadId, workspaceId: open.workspaceId }),
          ),
          projectProfileScope(store, open.workspaceId),
        )),
    // ace's Chrome saves downloads in the folder chosen for this daemon, else this machine's
    // Downloads folder; read per download, so a change applies to the next one. Global only:
    // a project's settings file must not send downloads into another folder.
    downloadFolder:
      options.browser?.downloadFolder ??
      (async () => {
        const chosen = (await services.settings?.get("browser.downloadDir", {}))?.value;
        return daemonDownloadFolder(typeof chosen === "string" ? chosen : "", downloadsHost());
      }),
    onEmbeddedRegistered: () => {
      void forget?.flush().catch((error: unknown) => context.log.log("warn", String(error)));
      void projectForget?.flush();
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
    // The person's own Chrome (ADR 0084): no desktop views, no fallback. A lost
    // tab or browser closes the thread's session there; it never moves to ace's own browser.
    const sessions = new BrowserService({
      dataDir: join(config.dataDir, "user-browser", "threads"),
      headlessBackend: new UserChromeTabsBackend(user.backend),
      backendPreference: () => "headless",
      tabLifecycle: false,
      tabBudget,
      // Agent tabs there come back after a restart too, from their own table.
      tabStore: new SqliteBrowserTabStore((sql) => store.statement(sql), "user_browser_tabs"),
      now,
      id,
      workspaceRoot,
      onArtifact,
    });
    resources.own(() => sessions.close());
    services.userBrowserSessions = sessions;
  }
  const forgetFailed = (error: unknown) =>
    context.log.log("warn", `Browser cleanup for a deleted thread: ${String(error)}`);
  forget = new BrowserForget(
    store,
    {
      closeThread: (threadId) => browser.closeThread(threadId),
      // The thread's browser data in the person's Chrome sessions goes too (#952).
      forgetThread: async (threadId, workspaceId) => {
        await services.userBrowserSessions?.forgetThread(threadId, workspaceId).catch(forgetFailed);
        return browser.forgetThread(threadId, workspaceId);
      },
    },
    forgetFailed,
  );
  resources.own(() => forget?.close());
  // A removed project's own profile goes (the Projects service reports removals).
  projectForget = new BrowserProjectForget(store, browser, (error) =>
    context.log.log("warn", `Browser cleanup for a removed project: ${String(error)}`),
  );
  resources.own(() => projectForget?.close());
  services.browserProjects = projectForget;
  const turns: BrowserTurnPort[] = [browser];
  if (services.userBrowserSessions) turns.push(services.userBrowserSessions);
  resources.own(
    watchBrowserTurns(store, turns, (error) =>
      context.log.log("warn", `Browser cleanup after an agent's turn: ${String(error)}`),
    ),
  );
  services.browser = browser;
}

import { sendBrowserMessage, sendBrowserStream } from "./browser-transport.ts";
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
        thread.deletedAt === undefined &&
        authorize(access) &&
        canReadThread(id) &&
        (workspaceId === undefined || thread.workspaceId === workspaceId)
      );
    },
    send: (message, serialized) => sendBrowserMessage(socket, message, serialized),
    sendStream: (pieces) => sendBrowserStream(socket, pieces),
    // A viewer on this machine gets its video at the top rate from the first picture.
    local: context.local === true,
    // Files the person picks for a page's file input, uploaded by this device as attachments.
    attachment: async (threadId, sha256) => {
      const device = context.device();
      const attachments = options.context;
      const thread = ThreadId.parse(threadId);
      const authorized = () =>
        context.connected() &&
        authorize("operate") &&
        canReadThread(thread) &&
        options.store.hasLiveThread(thread);
      if (!device || !attachments?.downloadAttachment || !authorized())
        throw new Error("Thread attachment unavailable");
      return attachments.downloadAttachment(device, thread, sha256, 32 * 1024 * 1024, authorized);
    },
  });
  return {
    // The desktop's video encoder events (ADR 0088), once it registered as the backend.
    binary: (frame) => backend?.binary(frame) ?? false,
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
              video: backendMessage.data.capabilities.video === true,
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
          } else if (backendMessage.data.type === "browser.backend.resumed") {
            // The desktop's computer woke: check every engine, ace's Chrome included (#947).
            if (!backend) throw new Error("Desktop backend not registered");
            options.browser?.wake();
          } else if (backendMessage.data.type === "browser.backend.drawable") {
            // The desktop's screen locked or unlocked: while it can't draw, its pages move.
            if (!backend) throw new Error("Desktop backend not registered");
            options.browser?.desktopDrawable(backendMessage.data.drawable);
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
