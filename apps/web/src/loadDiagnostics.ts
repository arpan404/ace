import { useSyncExternalStore } from "react";

export type LoadDiagnosticLevel = "info" | "success" | "warning" | "error";

export interface LoadDiagnosticEntry {
  readonly id: number;
  readonly level: LoadDiagnosticLevel;
  readonly phase: string;
  readonly message: string;
  readonly detail?: string;
  readonly timestamp: string;
  readonly sinceStartMs: number;
  readonly durationMs?: number;
}

interface LoadDiagnosticsState {
  readonly enabled: boolean;
  readonly expanded: boolean;
  readonly entries: ReadonlyArray<LoadDiagnosticEntry>;
  readonly startTimestamp: string;
  readonly origin: "renderer" | "desktop-window";
}

const LOAD_DIAGNOSTICS_STORAGE_KEY = "ace.loadDiagnostics.enabled";
const LOAD_DIAGNOSTICS_EXPANDED_STORAGE_KEY = "ace.loadDiagnostics.expanded";
const LOAD_DIAGNOSTICS_QUERY_PARAM = "loadDebug";
const MAX_ENTRIES = 200;
const listeners = new Set<() => void>();

type LoadDiagnosticsOrigin =
  | {
      readonly kind: "renderer";
      readonly startedAtMs: number;
      readonly startedAtTimestamp: string;
    }
  | {
      readonly kind: "desktop-window";
      readonly startedAtEpochMs: number;
      readonly startedAtTimestamp: string;
    };

let origin = resolveInitialOrigin();

let nextEntryId = 1;
let initialized = false;
let state: LoadDiagnosticsState = {
  enabled: resolveInitialEnabled(),
  expanded: resolveInitialExpanded(),
  entries: [],
  startTimestamp: origin.startedAtTimestamp,
  origin: origin.kind,
};

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function getSnapshot(): LoadDiagnosticsState {
  return state;
}

function resolveInitialEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const search = typeof window.location?.search === "string" ? window.location.search : "";
  const queryEnabled = new URLSearchParams(search).get(LOAD_DIAGNOSTICS_QUERY_PARAM);
  if (queryEnabled === "1" || queryEnabled === "true") {
    return true;
  }

  const persisted = globalThis.localStorage?.getItem?.(LOAD_DIAGNOSTICS_STORAGE_KEY);
  if (persisted === "1" || persisted === "true") {
    return true;
  }
  if (persisted === "0" || persisted === "false") {
    return false;
  }

  return import.meta.env.DEV;
}

function resolveInitialOrigin(): LoadDiagnosticsOrigin {
  if (typeof window !== "undefined") {
    const shownAt = window.desktopBridge?.getWindowShownAt?.();
    if (typeof shownAt === "number" && Number.isFinite(shownAt) && shownAt > 0) {
      return {
        kind: "desktop-window",
        startedAtEpochMs: shownAt,
        startedAtTimestamp: new Date(shownAt).toISOString(),
      };
    }
  }

  return {
    kind: "renderer",
    startedAtMs: now(),
    startedAtTimestamp: new Date().toISOString(),
  };
}

function resolveInitialExpanded(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const search = typeof window.location?.search === "string" ? window.location.search : "";
  const queryEnabled = new URLSearchParams(search).get(LOAD_DIAGNOSTICS_QUERY_PARAM);
  if (queryEnabled === "1" || queryEnabled === "true") {
    return true;
  }

  const persisted = globalThis.localStorage?.getItem?.(LOAD_DIAGNOSTICS_EXPANDED_STORAGE_KEY);
  return persisted === "1" || persisted === "true";
}

function persistBoolean(key: string, value: boolean): void {
  if (typeof window === "undefined") {
    return;
  }

  globalThis.localStorage?.setItem?.(key, value ? "1" : "0");
}

function updateState(nextState: LoadDiagnosticsState): void {
  state = nextState;
  emit();
}

function formatDetail(detail: unknown): string | undefined {
  if (detail === undefined) {
    return undefined;
  }
  if (typeof detail === "string") {
    return detail;
  }
  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return String(detail);
  }
}

function consoleMethod(level: LoadDiagnosticLevel): "info" | "warn" | "error" {
  switch (level) {
    case "warning":
      return "warn";
    case "error":
      return "error";
    default:
      return "info";
  }
}

export function logLoadDiagnostic(input: {
  readonly phase: string;
  readonly message: string;
  readonly level?: LoadDiagnosticLevel;
  readonly detail?: unknown;
  readonly durationMs?: number;
}): LoadDiagnosticEntry {
  const sinceStartMs =
    origin.kind === "desktop-window"
      ? Date.now() - origin.startedAtEpochMs
      : now() - origin.startedAtMs;
  const detail = formatDetail(input.detail);
  const entry: LoadDiagnosticEntry = {
    id: nextEntryId++,
    level: input.level ?? "info",
    phase: input.phase,
    message: input.message,
    ...(detail ? { detail } : {}),
    timestamp: new Date().toISOString(),
    sinceStartMs,
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
  };

  const prefix = `[ace:load] [${entry.phase}] ${entry.message}`;
  if (detail) {
    console[consoleMethod(entry.level)](prefix, detail);
  } else {
    console[consoleMethod(entry.level)](prefix);
  }

  updateState({
    ...state,
    entries: [...state.entries.slice(-(MAX_ENTRIES - 1)), entry],
  });

  return entry;
}

export function beginLoadPhase(
  phase: string,
  message: string,
  detail?: unknown,
): {
  readonly success: (message?: string, detail?: unknown) => void;
  readonly warning: (message: string, detail?: unknown) => void;
  readonly error: (message: string, detail?: unknown) => void;
} {
  const phaseStartMs = now();
  logLoadDiagnostic({ phase, message: `${message} started`, detail });

  const complete = (
    level: LoadDiagnosticLevel,
    nextMessage: string,
    nextDetail?: unknown,
  ): void => {
    logLoadDiagnostic({
      phase,
      level,
      message: nextMessage,
      detail: nextDetail,
      durationMs: now() - phaseStartMs,
    });
  };

  return {
    success: (nextMessage = `${message} finished`, nextDetail) =>
      complete("success", nextMessage, nextDetail),
    warning: (nextMessage, nextDetail) => complete("warning", nextMessage, nextDetail),
    error: (nextMessage, nextDetail) => complete("error", nextMessage, nextDetail),
  };
}

export function initLoadDiagnostics(): void {
  if (initialized || typeof window === "undefined") {
    return;
  }
  initialized = true;

  logLoadDiagnostic({
    phase: "app",
    message: "Load diagnostics initialized",
    detail: {
      startTimestamp: origin.startedAtTimestamp,
      origin: origin.kind,
      userAgent: window.navigator.userAgent,
    },
  });

  window.addEventListener("error", (event) => {
    logLoadDiagnostic({
      phase: "window",
      level: "error",
      message: "Unhandled error",
      detail: event.error ?? event.message,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    logLoadDiagnostic({
      phase: "window",
      level: "error",
      message: "Unhandled promise rejection",
      detail: event.reason,
    });
  });

  const navigationEntry = window.performance.getEntriesByType("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  if (navigationEntry) {
    logLoadDiagnostic({
      phase: "browser",
      message: "Navigation timing snapshot",
      detail: {
        responseEndMs: Number(navigationEntry.responseEnd.toFixed(1)),
        domInteractiveMs: Number(navigationEntry.domInteractive.toFixed(1)),
        domCompleteMs: Number(navigationEntry.domComplete.toFixed(1)),
      },
    });
  }

  if ("PerformanceObserver" in window) {
    try {
      const paintObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          logLoadDiagnostic({
            phase: "paint",
            message: `${entry.name} reported`,
            detail: { startTimeMs: Number(entry.startTime.toFixed(1)) },
          });
        }
      });
      paintObserver.observe({ type: "paint", buffered: true });
    } catch {
      // Ignore unsupported paint observers.
    }

    try {
      const longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          logLoadDiagnostic({
            phase: "longtask",
            level: "warning",
            message: "Long task detected",
            detail: { durationMs: Number(entry.duration.toFixed(1)) },
          });
        }
      });
      longTaskObserver.observe({ type: "longtask", buffered: true });
    } catch {
      // Ignore unsupported longtask observers.
    }
  }

  if (document.readyState === "complete") {
    logLoadDiagnostic({ phase: "browser", message: "Window load event already completed" });
  } else {
    window.addEventListener(
      "load",
      () => {
        logLoadDiagnostic({ phase: "browser", message: "Window load event fired" });
      },
      { once: true },
    );
  }
}

export function setLoadDiagnosticsEnabled(enabled: boolean): void {
  persistBoolean(LOAD_DIAGNOSTICS_STORAGE_KEY, enabled);
  updateState({ ...state, enabled });
  logLoadDiagnostic({
    phase: "console",
    message: enabled ? "On-screen diagnostics enabled" : "On-screen diagnostics disabled",
  });
}

export function setLoadDiagnosticsExpanded(expanded: boolean): void {
  persistBoolean(LOAD_DIAGNOSTICS_EXPANDED_STORAGE_KEY, expanded);
  updateState({ ...state, expanded });
}

export function clearLoadDiagnostics(): void {
  updateState({ ...state, entries: [] });
  logLoadDiagnostic({ phase: "console", message: "Diagnostics log cleared" });
}

export function formatLoadDiagnosticsReport(entries = state.entries): string {
  return entries
    .map((entry) =>
      [
        `${entry.timestamp}`,
        `[${entry.level}]`,
        `[${entry.phase}]`,
        entry.message,
        entry.detail ? `\n${entry.detail}` : null,
      ]
        .filter(Boolean)
        .join(" "),
    )
    .join("\n\n");
}

export function useLoadDiagnostics(): LoadDiagnosticsState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function getLoadDiagnosticsState(): LoadDiagnosticsState {
  return getSnapshot();
}

export function __resetLoadDiagnosticsForTests(): void {
  nextEntryId = 1;
  initialized = false;
  origin = resolveInitialOrigin();
  state = {
    enabled: true,
    expanded: false,
    entries: [],
    startTimestamp: origin.startedAtTimestamp,
    origin: origin.kind,
  };
  listeners.clear();
}
