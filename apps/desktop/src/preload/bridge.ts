import type { z } from "zod";
import {
  eventChannel,
  events,
  requestChannel,
  requests,
  type EventChannel,
  type EventOf,
  type RequestChannel,
  type RequestOf,
  type ResultOf,
} from "../shared/channels.ts";
import type { AppInfo } from "../shared/contract.ts";

/** The slice of `ipcRenderer` the bridge needs; injected so it can be tested without Electron. */
export interface BridgeIpc {
  invoke(channel: string, payload: unknown): Promise<unknown>;
  on(channel: string, listener: (payload: unknown) => void): () => void;
}

/** Thrown to the page when a call is refused before it reaches the main process. */
export class BridgeError extends Error {
  override name = "BridgeError";
}

/**
 * Builds `window.ace`. Arguments are parsed before they are sent, results before they are
 * returned, and events before listeners see them; malformed events are dropped, never thrown
 * into the page. The page gets plain functions and data only, never `ipcRenderer`.
 */
export function createBridge(ipc: BridgeIpc, info: AppInfo) {
  async function call<C extends RequestChannel>(
    channel: C,
    payload?: RequestOf<C>,
  ): Promise<ResultOf<C>> {
    const spec = requests[channel];
    const parsed = (spec.request as z.ZodType).safeParse(payload);
    if (!parsed.success)
      throw new BridgeError(`Invalid ${channel} request: ${parsed.error.issues[0]?.message}`);
    const result = (spec.result as z.ZodType<ResultOf<C>>).safeParse(
      await ipc.invoke(requestChannel(channel), parsed.data),
    );
    if (!result.success) throw new BridgeError(`Invalid ${channel} response`);
    return result.data;
  }
  function subscribe<C extends EventChannel>(
    channel: C,
    listener: (value: EventOf<C>) => void,
  ): () => void {
    if (typeof listener !== "function") throw new BridgeError("Listener must be a function");
    return ipc.on(eventChannel(channel), (payload) => {
      const parsed = (events[channel] as z.ZodType<EventOf<C>>).safeParse(payload);
      if (parsed.success) listener(parsed.data);
    });
  }

  return {
    version: info.version,
    platform: info.platform,
    arch: info.arch,
    electron: info.electron,
    packaged: info.packaged,
    daemon: {
      connection: () => call("daemon.connection"),
      status: () => call("daemon.status"),
      restart: () => call("daemon.restart"),
      diagnose: () => call("daemon.diagnose"),
      pause: (paused: boolean) => call("daemon.pause", paused),
      onStatus: (listener: (value: EventOf<"daemon.status">) => void) =>
        subscribe("daemon.status", listener),
    },
    onboarding: {
      providers: () => call("onboarding.providers"),
      toolchains: () => call("system.toolchains"),
    },
    shell: {
      openInEditor: (request: RequestOf<"shell.openInEditor">) =>
        call("shell.openInEditor", request),
      reveal: (path: string) => call("shell.reveal", { path }),
      openExternal: (url: string) => call("shell.openExternal", url),
    },
    notifications: {
      show: (request: RequestOf<"notify.show">) => call("notify.show", request),
      setBadge: (count: number) => call("badge.set", count),
    },
    window: {
      minimize: () => call("window.action", "minimize"),
      toggleMaximize: () => call("window.action", "maximize"),
      toggleFullScreen: () => call("window.action", "fullscreen"),
      close: () => call("window.action", "close"),
      state: () => call("window.state"),
      onChange: (listener: (value: EventOf<"window.changed">) => void) =>
        subscribe("window.changed", listener),
    },
    theme: {
      appearance: () => call("theme.appearance"),
      setSource: (source: RequestOf<"theme.setSource">) => call("theme.setSource", source),
      onChange: (listener: (value: EventOf<"theme.changed">) => void) =>
        subscribe("theme.changed", listener),
    },
    settings: {
      get: () => call("settings.get"),
      update: (patch: RequestOf<"settings.update">) => call("settings.update", patch),
      onChange: (listener: (value: EventOf<"settings.changed">) => void) =>
        subscribe("settings.changed", listener),
    },
    permissions: {
      status: () => call("permissions.status"),
      open: (pane: RequestOf<"permissions.open">) => call("permissions.open", pane),
    },
    browser: {
      place: (placement: RequestOf<"browser.place">) => call("browser.place", placement),
      setController: (request: RequestOf<"browser.control">) => call("browser.control", request),
      onController: (listener: (value: EventOf<"browser.controller">) => void) =>
        subscribe("browser.controller", listener),
    },
    updates: {
      check: () => call("updates.check"),
      onStatus: (listener: (value: EventOf<"updates.status">) => void) =>
        subscribe("updates.status", listener),
    },
    onDeepLink: (listener: (value: EventOf<"deep-link">) => void) =>
      subscribe("deep-link", listener),
    onMenuCommand: (listener: (value: EventOf<"menu.command">) => void) =>
      subscribe("menu.command", listener),
    onSystemResumed: (listener: () => void) => subscribe("system.resumed", () => listener()),
  };
}

export type AceBridge = ReturnType<typeof createBridge>;
