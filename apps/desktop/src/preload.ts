import type { DesktopBridge, DesktopMenuAction } from "@ace/contracts";
import { contextBridge, ipcRenderer } from "electron";

const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
const CONFIRM_CHANNEL = "desktop:confirm";
const REPAIR_BROWSER_STORAGE_CHANNEL = "desktop:repair-browser-storage";
const SET_THEME_CHANNEL = "desktop:set-theme";
const APP_ZOOM_CHANNEL = "desktop:app-zoom";
const OPEN_DETACHED_BROWSER_CHANNEL = "desktop:open-detached-browser";
const CONTEXT_MENU_CHANNEL = "desktop:context-menu";
const OPEN_EXTERNAL_CHANNEL = "desktop:open-external";
const SHOW_NOTIFICATION_CHANNEL = "desktop:show-notification";
const CLOSE_NOTIFICATION_CHANNEL = "desktop:close-notification";
const NOTIFICATION_CLICK_CHANNEL = "desktop:notification-click";
const NOTIFICATION_REPLY_CHANNEL = "desktop:notification-reply";
const MENU_ACTION_CHANNEL = "desktop:menu-action";
const CLI_STATE_CHANNEL = "desktop:cli-state";
const CLI_GET_STATE_CHANNEL = "desktop:cli-get-state";
const CLI_INSTALL_CHANNEL = "desktop:cli-install";
const UPDATE_STATE_CHANNEL = "desktop:update-state";
const UPDATE_GET_STATE_CHANNEL = "desktop:update-get-state";
const UPDATE_CHECK_CHANNEL = "desktop:update-check";
const UPDATE_DOWNLOAD_CHANNEL = "desktop:update-download";
const UPDATE_INSTALL_CHANNEL = "desktop:update-install";
const GET_RENDERER_BOOTSTRAP_CHANNEL = "desktop:get-renderer-bootstrap";
const WINDOW_SHOWN_AT_CHANGED_CHANNEL = "desktop:window-shown-at-changed";
const TITLEBAR_LEFT_INSET_CHANGED_CHANNEL = "desktop:titlebar-left-inset-changed";
const WINDOW_RESUME_CHANNEL = "desktop:window-resume";
const GET_NOTIFICATION_PERMISSION_CHANNEL = "desktop:get-notification-permission";
const REQUEST_NOTIFICATION_PERMISSION_CHANNEL = "desktop:request-notification-permission";
const PAIRING_URL_CHANNEL = "desktop:pairing-url";
const BROWSER_OPEN_URL_CHANNEL = "desktop:browser-open-url";
const BROWSER_CONTEXT_MENU_SHOWN_CHANNEL = "desktop:browser-context-menu-shown";
const BROWSER_SHORTCUT_ACTION_CHANNEL = "desktop:browser-shortcut-action";
const ORCHESTRATION_EVENT_CHANNEL = "desktop:orchestration-event";
const SERVER_CONFIG_EVENT_CHANNEL = "desktop:server-config-event";

interface DesktopRendererBootstrapPayload {
  readonly isDevelopmentBuild: boolean;
  readonly titlebarLeftInset: number | null;
  readonly windowShownAt: number | null;
  readonly wsUrl: string | null;
}

function readDesktopRendererBootstrap(): DesktopRendererBootstrapPayload {
  const payload = ipcRenderer.sendSync(GET_RENDERER_BOOTSTRAP_CHANNEL) as
    | Partial<DesktopRendererBootstrapPayload>
    | null
    | undefined;

  return {
    isDevelopmentBuild: payload?.isDevelopmentBuild === true,
    titlebarLeftInset:
      typeof payload?.titlebarLeftInset === "number" &&
      Number.isFinite(payload.titlebarLeftInset) &&
      payload.titlebarLeftInset >= 0
        ? payload.titlebarLeftInset
        : null,
    windowShownAt:
      typeof payload?.windowShownAt === "number" && Number.isFinite(payload.windowShownAt)
        ? payload.windowShownAt
        : null,
    wsUrl: typeof payload?.wsUrl === "string" ? payload.wsUrl : null,
  };
}

const desktopRendererBootstrap = readDesktopRendererBootstrap();
let cachedTitlebarLeftInset = desktopRendererBootstrap.titlebarLeftInset;
let cachedWindowShownAt = desktopRendererBootstrap.windowShownAt;
const pairingUrlListeners = new Set<(url: string) => void>();
const pendingPairingUrls: string[] = [];

function enqueuePairingUrl(url: unknown): void {
  if (typeof url !== "string" || url.length === 0) {
    return;
  }

  if (pairingUrlListeners.size === 0) {
    pendingPairingUrls.push(url);
    return;
  }

  for (const listener of pairingUrlListeners) {
    listener(url);
  }
}

ipcRenderer.on(PAIRING_URL_CHANNEL, (_event, url: unknown) => {
  enqueuePairingUrl(url);
});

ipcRenderer.on(WINDOW_SHOWN_AT_CHANGED_CHANNEL, (_event, value: unknown) => {
  cachedWindowShownAt = typeof value === "number" && Number.isFinite(value) ? value : null;
});

ipcRenderer.on(TITLEBAR_LEFT_INSET_CHANGED_CHANNEL, (_event, value: unknown) => {
  cachedTitlebarLeftInset =
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
});

contextBridge.exposeInMainWorld("desktopBridge", {
  getWsUrl: () => desktopRendererBootstrap.wsUrl,
  getIsDevelopmentBuild: () => desktopRendererBootstrap.isDevelopmentBuild,
  getWindowShownAt: () => cachedWindowShownAt,
  getTitlebarLeftInset: () => cachedTitlebarLeftInset,
  onTitlebarLeftInsetChange: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, inset: unknown) => {
      if (typeof inset !== "number" || !Number.isFinite(inset) || inset < 0) return;
      cachedTitlebarLeftInset = inset;
      listener(inset);
    };

    ipcRenderer.on(TITLEBAR_LEFT_INSET_CHANGED_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(TITLEBAR_LEFT_INSET_CHANGED_CHANNEL, wrappedListener);
    };
  },
  onWindowResume: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, reason: unknown) => {
      if (reason !== "focus" && reason !== "resume" && reason !== "unlock-screen") {
        return;
      }
      listener(reason);
    };

    ipcRenderer.on(WINDOW_RESUME_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(WINDOW_RESUME_CHANNEL, wrappedListener);
    };
  },
  getNotificationPermission: async () => {
    const result = await ipcRenderer.invoke(GET_NOTIFICATION_PERMISSION_CHANNEL);
    return result === "granted" || result === "denied" || result === "default"
      ? result
      : "unsupported";
  },
  requestNotificationPermission: async () => {
    const result = await ipcRenderer.invoke(REQUEST_NOTIFICATION_PERMISSION_CHANNEL);
    return result === "granted" || result === "denied" || result === "default"
      ? result
      : "unsupported";
  },
  pickFolder: (options) => ipcRenderer.invoke(PICK_FOLDER_CHANNEL, options),
  confirm: (message) => ipcRenderer.invoke(CONFIRM_CHANNEL, message),
  repairBrowserStorage: () => ipcRenderer.invoke(REPAIR_BROWSER_STORAGE_CHANNEL),
  setTheme: (theme) => ipcRenderer.invoke(SET_THEME_CHANNEL, theme),
  showContextMenu: (items, position) => ipcRenderer.invoke(CONTEXT_MENU_CHANNEL, items, position),
  openExternal: (url: string) => ipcRenderer.invoke(OPEN_EXTERNAL_CHANNEL, url),
  showNotification: async (input) => {
    const result = await ipcRenderer.invoke(SHOW_NOTIFICATION_CHANNEL, input);
    return result === true;
  },
  closeNotification: async (id) => {
    const result = await ipcRenderer.invoke(CLOSE_NOTIFICATION_CHANNEL, id);
    return result === true;
  },
  applyAppZoom: (action) => ipcRenderer.invoke(APP_ZOOM_CHANNEL, action),
  openDetachedBrowser: async (input) => {
    const result = await ipcRenderer.invoke(OPEN_DETACHED_BROWSER_CHANNEL, input);
    return result === true;
  },
  onNotificationClick: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, event: unknown) => {
      if (typeof event !== "object" || event === null) return;
      const payload = event as { id?: unknown; deepLink?: unknown };
      if (typeof payload.id !== "string" || payload.id.length === 0) return;
      listener({
        id: payload.id,
        ...(typeof payload.deepLink === "string" && payload.deepLink.length > 0
          ? { deepLink: payload.deepLink }
          : {}),
      });
    };

    ipcRenderer.on(NOTIFICATION_CLICK_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(NOTIFICATION_CLICK_CHANNEL, wrappedListener);
    };
  },
  onNotificationReply: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, event: unknown) => {
      if (typeof event !== "object" || event === null) return;
      const payload = event as { id?: unknown; response?: unknown; deepLink?: unknown };
      if (typeof payload.id !== "string" || payload.id.length === 0) return;
      if (typeof payload.response !== "string") return;
      listener({
        id: payload.id,
        response: payload.response,
        ...(typeof payload.deepLink === "string" && payload.deepLink.length > 0
          ? { deepLink: payload.deepLink }
          : {}),
      });
    };

    ipcRenderer.on(NOTIFICATION_REPLY_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(NOTIFICATION_REPLY_CHANNEL, wrappedListener);
    };
  },
  onMenuAction: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, action: unknown) => {
      if (typeof action !== "string") return;
      // Keep preload free of non-Electron runtime imports so it works in sandboxed renderers.
      listener(action as DesktopMenuAction);
    };

    ipcRenderer.on(MENU_ACTION_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(MENU_ACTION_CHANNEL, wrappedListener);
    };
  },
  getCliInstallState: () => ipcRenderer.invoke(CLI_GET_STATE_CHANNEL),
  installCli: () => ipcRenderer.invoke(CLI_INSTALL_CHANNEL),
  onCliInstallState: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (typeof state !== "object" || state === null) return;
      listener(state as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(CLI_STATE_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(CLI_STATE_CHANNEL, wrappedListener);
    };
  },
  getUpdateState: () => ipcRenderer.invoke(UPDATE_GET_STATE_CHANNEL),
  checkForUpdate: () => ipcRenderer.invoke(UPDATE_CHECK_CHANNEL),
  downloadUpdate: () => ipcRenderer.invoke(UPDATE_DOWNLOAD_CHANNEL),
  installUpdate: () => ipcRenderer.invoke(UPDATE_INSTALL_CHANNEL),
  onUpdateState: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (typeof state !== "object" || state === null) return;
      listener(state as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(UPDATE_STATE_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(UPDATE_STATE_CHANNEL, wrappedListener);
    };
  },
  onPairingUrl: (listener) => {
    pairingUrlListeners.add(listener);
    while (pendingPairingUrls.length > 0) {
      const nextUrl = pendingPairingUrls.shift();
      if (nextUrl) {
        listener(nextUrl);
      }
    }
    return () => {
      pairingUrlListeners.delete(listener);
    };
  },
  onBrowserOpenUrl: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, url: unknown) => {
      if (typeof url !== "string" || url.length === 0) return;
      listener(url);
    };

    ipcRenderer.on(BROWSER_OPEN_URL_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(BROWSER_OPEN_URL_CHANNEL, wrappedListener);
    };
  },
  onBrowserContextMenuShown: (listener) => {
    const wrappedListener = () => {
      listener();
    };

    ipcRenderer.on(BROWSER_CONTEXT_MENU_SHOWN_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(BROWSER_CONTEXT_MENU_SHOWN_CHANNEL, wrappedListener);
    };
  },
  onBrowserShortcutAction: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, action: unknown) => {
      if (typeof action !== "string" || action.length === 0) return;
      listener(action as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(BROWSER_SHORTCUT_ACTION_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(BROWSER_SHORTCUT_ACTION_CHANNEL, wrappedListener);
    };
  },
  sendOrchestrationEvent: (event: unknown) => {
    ipcRenderer.send(ORCHESTRATION_EVENT_CHANNEL, event);
  },
  sendServerConfigEvent: (event: unknown) => {
    ipcRenderer.send(SERVER_CONFIG_EVENT_CHANNEL, event);
  },
} satisfies DesktopBridge);
