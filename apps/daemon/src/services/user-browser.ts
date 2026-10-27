import { homedir } from "node:os";
import { WebSocket } from "ws";
import type { UserBrowserSettings, UserBrowserSettingsResult } from "@ace/protocol";
import type { UserChromeLink } from "@ace/browser";
import { UserBrowserService } from "../user-browser.ts";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";

/** Windows registers native messaging hosts under %LOCALAPPDATA%. */
function windowsBrowserEnv() {
  const env = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
  };
  return env;
}

export async function startUserBrowser(context: ServiceContext): Promise<void> {
  const service = new UserBrowserService({
    dataDir: context.config.dataDir,
    platform: process.platform,
    home: homedir(),
    env: { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME },
    ...(process.platform === "win32" && { env: windowsBrowserEnv() }),
    node: process.execPath,
    devices: context.store.devices,
    now: context.now,
    clock: {
      now: () => performance.now(),
      set: (delay, work) => {
        const timer = setTimeout(work, delay);
        timer.unref();
        return () => clearTimeout(timer);
      },
    },
    // ace's browser service starts later; its encoder is looked up when a viewer first needs it.
    videoEncoder: () => context.services.browser?.videoEncoder(),
    ...context.options.userBrowser,
  });
  context.resources.own(() => service.close());
  context.services.userBrowser = service;
}

async function settings(
  service: UserBrowserService,
  operation: UserBrowserSettings["operation"],
): Promise<UserBrowserSettingsResult["result"]> {
  try {
    const status =
      operation === "install"
        ? await service.install()
        : operation === "revoke"
          ? await service.revoke()
          : operation === "stop"
            ? await service.stop()
            : await service.status();
    return { kind: "status", status };
  } catch (error) {
    return {
      kind: "error",
      code: "failed",
      message: (error instanceof Error ? error.message : "Use my Chrome failed").slice(0, 512),
    };
  }
}

/**
 * The native host's socket (a `user-browser` credential, local only) registers one browser link;
 * an administrator's socket may use the Settings operations. Nothing else crosses here.
 */
export function createUserBrowserSession(context: SocketContext): SocketService {
  let link: UserChromeLink | undefined;
  let stopRevocation: (() => void) | undefined;
  const { socket } = context;
  return {
    close() {
      stopRevocation?.();
      link?.close("Your browser disconnected");
    },
    handle(message, device) {
      if (!message.type.startsWith("user_browser.")) return false;
      const service = context.options.userBrowser;
      if (message.type === "user_browser.settings") {
        const requestId = message.requestId;
        if (!context.authorize("admin") || !service) {
          context.send({
            type: "user_browser.settings.result",
            requestId,
            result: service
              ? {
                  kind: "error",
                  code: "forbidden",
                  message: "Host administrator access is required.",
                }
              : { kind: "error", code: "unavailable", message: "Use my Chrome is unavailable." },
          });
          return true;
        }
        const task = settings(service, message.operation)
          .then((result) => {
            if (context.authorize("admin"))
              context.send({ type: "user_browser.settings.result", requestId, result });
          })
          .catch((error: unknown) => context.options.log?.(error))
          .finally(() => context.tasks.delete(task));
        context.tasks.add(task);
        return true;
      }
      const credential = context.options.store.devices.get(device);
      const allowed =
        service !== undefined &&
        credential?.revokedAt === null &&
        credential.scopes.includes("user-browser");
      if (!allowed) {
        context.fail("user_browser_denied", "A Use my Chrome credential is required", true);
        return true;
      }
      if (message.type === "user_browser.register") {
        if (link) {
          context.fail("user_browser_denied", "This connection already registered a browser");
          return true;
        }
        const registered = service.hub.register(message.browser, {
          send: (outgoing) => {
            if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 4 * 1024 * 1024)
              return false;
            socket.send(JSON.stringify(outgoing));
            return true;
          },
          close: (reason) => {
            if (socket.readyState === WebSocket.OPEN) socket.close(4009, reason.slice(0, 120));
          },
        });
        link = registered;
        stopRevocation = context.options.store.devices.onRevoke((id) => {
          if (id === device) registered.close("Use my Chrome was revoked");
        });
        socket.send(
          JSON.stringify({
            type: "user_browser.registered",
            requestId: message.requestId,
            connectionId: registered.connectionId,
          }),
        );
        return true;
      }
      link?.handle(message);
      return true;
    },
  };
}
