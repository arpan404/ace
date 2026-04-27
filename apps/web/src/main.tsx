import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "@xterm/xterm/css/xterm.css";
import "./index.css";
import "./theme-presets.css";
import "./appearancePrefs";

import { isElectron } from "./env";
import { getRouter } from "./router";
import { APP_DISPLAY_NAME } from "./branding";
import { beginLoadPhase, initLoadDiagnostics, logLoadDiagnostic } from "./loadDiagnostics";
import {
  DESKTOP_TITLEBAR_LEFT_INSET_CSS_VARIABLE,
  MAC_TITLEBAR_LEFT_INSET_PX,
} from "./lib/desktopChrome";

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
initLoadDiagnostics();
logLoadDiagnostic({
  phase: "main",
  message: "Evaluating application entrypoint",
  detail: { mode: isElectron ? "electron" : "browser" },
});

const history = isElectron ? createHashHistory() : createBrowserHistory();
const routerPhase = beginLoadPhase("main", "Creating router");
const router = getRouter(history);
routerPhase.success("Router created");

let currentDesktopTitlebarLeftInset: number | null = null;

const applyDesktopTitlebarLeftInset = (titlebarLeftInset: number | null | undefined) => {
  if (
    typeof titlebarLeftInset !== "number" ||
    !Number.isFinite(titlebarLeftInset) ||
    titlebarLeftInset < 0
  ) {
    return;
  }

  const nextInset = Math.round(titlebarLeftInset);
  if (nextInset === currentDesktopTitlebarLeftInset) {
    return;
  }

  currentDesktopTitlebarLeftInset = nextInset;
  document.documentElement.style.setProperty(
    DESKTOP_TITLEBAR_LEFT_INSET_CSS_VARIABLE,
    `${nextInset}px`,
  );
};

const syncDesktopTitlebarLeftInset = () => {
  applyDesktopTitlebarLeftInset(
    window.desktopBridge?.getTitlebarLeftInset?.() ?? (isElectron ? MAC_TITLEBAR_LEFT_INSET_PX : 0),
  );
};

syncDesktopTitlebarLeftInset();

if (isElectron && typeof window.desktopBridge?.getTitlebarLeftInset === "function") {
  let pendingRaf = 0;
  const scheduleInsetSync = () => {
    if (pendingRaf !== 0) {
      return;
    }
    pendingRaf = window.requestAnimationFrame(() => {
      pendingRaf = 0;
      syncDesktopTitlebarLeftInset();
    });
  };

  window.addEventListener("focus", scheduleInsetSync);
  window.desktopBridge.onTitlebarLeftInsetChange?.(applyDesktopTitlebarLeftInset);
}

if (isElectron) {
  let isNativeWindowResizing = false;
  let resizeSettleTimer = 0;
  const markNativeWindowResizing = () => {
    if (!isNativeWindowResizing) {
      isNativeWindowResizing = true;
      document.documentElement.classList.add("native-window-resizing");
      window.dispatchEvent(new CustomEvent("ace:native-window-resize-start"));
    }
    if (resizeSettleTimer !== 0) {
      window.clearTimeout(resizeSettleTimer);
    }
    resizeSettleTimer = window.setTimeout(() => {
      resizeSettleTimer = 0;
      isNativeWindowResizing = false;
      document.documentElement.classList.remove("native-window-resizing");
      window.dispatchEvent(new CustomEvent("ace:native-window-resize-end"));
    }, 140);
  };

  window.addEventListener("resize", markNativeWindowResizing, { passive: true });
}

document.title = APP_DISPLAY_NAME;
logLoadDiagnostic({ phase: "main", message: "Document title updated", detail: APP_DISPLAY_NAME });

const rootElement = document.getElementById("root") as HTMLElement;
const renderPhase = beginLoadPhase("main", "Rendering React root");
ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
renderPhase.success("React root render scheduled");

queueMicrotask(() => {
  logLoadDiagnostic({ phase: "main", message: "Initial microtask queue drained" });
});

requestAnimationFrame(() => {
  logLoadDiagnostic({ phase: "paint", message: "First animation frame after root render" });
});
