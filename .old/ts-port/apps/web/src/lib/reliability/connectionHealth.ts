import { useSyncExternalStore } from "react";
import { toastManager } from "~/components/ui/toast";
import type { WsTransportConnectionState } from "~/wsTransport";

export type ConnectionHealthKind =
  | "healthy"
  | "connecting"
  | "disconnected"
  | "reconnecting"
  | "degraded";

export interface ConnectionHealthSnapshot {
  kind: ConnectionHealthKind;
  lastChangedAt: number;
  lastConnectedAt: number | null;
  lastDisconnectedAt: number | null;
  reconnectCount: number;
  lastError: string | null;
}

const initialSnapshot: ConnectionHealthSnapshot = {
  kind: "connecting",
  lastChangedAt: Date.now(),
  lastConnectedAt: null,
  lastDisconnectedAt: null,
  reconnectCount: 0,
  lastError: null,
};

type Listener = () => void;

let snapshot = initialSnapshot;
const listeners = new Set<Listener>();
let connectionInterruptedToastId: ReturnType<typeof toastManager.add> | null = null;
let connectionHealthToastsEnabled = false;

function emit(next: ConnectionHealthSnapshot): void {
  if (
    snapshot.kind === next.kind &&
    snapshot.lastConnectedAt === next.lastConnectedAt &&
    snapshot.lastDisconnectedAt === next.lastDisconnectedAt &&
    snapshot.reconnectCount === next.reconnectCount &&
    snapshot.lastError === next.lastError
  ) {
    return;
  }
  snapshot = next;
  for (const listener of listeners) {
    listener();
  }
}

function transition(
  kind: ConnectionHealthKind,
  patch: Partial<Omit<ConnectionHealthSnapshot, "kind" | "lastChangedAt">> = {},
): void {
  emit({
    ...snapshot,
    ...patch,
    kind,
    lastChangedAt: Date.now(),
  });
}

export function getConnectionHealthSnapshot(): ConnectionHealthSnapshot {
  return snapshot;
}

function subscribeConnectionHealth(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useConnectionHealth(): ConnectionHealthSnapshot {
  return useSyncExternalStore(
    subscribeConnectionHealth,
    getConnectionHealthSnapshot,
    getConnectionHealthSnapshot,
  );
}

export function setConnectionHealthToastsEnabled(enabled: boolean): void {
  connectionHealthToastsEnabled = enabled;
  if (!enabled && connectionInterruptedToastId) {
    toastManager.close(connectionInterruptedToastId);
    connectionInterruptedToastId = null;
  }
}

function noteConnectionHealthConnected(): void {
  transition("healthy", {
    lastConnectedAt: Date.now(),
    lastError: null,
  });
}

function noteConnectionHealthDisconnected(error: string | null): void {
  if (snapshot.kind === "disconnected" && snapshot.lastError === error) {
    return;
  }
  const wasHealthy = snapshot.kind === "healthy";
  transition("disconnected", {
    lastDisconnectedAt: Date.now(),
    lastError: error,
  });
  if (wasHealthy && connectionHealthToastsEnabled) {
    const payload = {
      type: "warning" as const,
      title: "Connection interrupted",
      description: "Trying to reconnect...",
    };
    if (connectionInterruptedToastId) {
      toastManager.update(connectionInterruptedToastId, payload);
    } else {
      connectionInterruptedToastId = toastManager.add(payload);
    }
  }
}

function noteConnectionHealthReconnecting(error?: string | null): void {
  if (snapshot.kind === "healthy") {
    return;
  }
  transition("reconnecting", {
    lastError: error ?? snapshot.lastError,
  });
}

function noteConnectionHealthReconnected(): void {
  const reconnectCount = snapshot.reconnectCount + 1;
  transition("healthy", {
    lastConnectedAt: Date.now(),
    reconnectCount,
    lastError: null,
  });
  const payload = {
    type: "success" as const,
    title: "Reconnected",
    description:
      reconnectCount > 1
        ? `ace is back online after ${String(reconnectCount)} attempts.`
        : "ace is back online.",
    data: { dismissAfterVisibleMs: 3_000 },
  };
  if (!connectionHealthToastsEnabled) {
    connectionInterruptedToastId = null;
    return;
  }
  if (connectionInterruptedToastId) {
    toastManager.update(connectionInterruptedToastId, payload);
    connectionInterruptedToastId = null;
  } else {
    toastManager.add(payload);
  }
}

export function applyTransportConnectionHealthState(state: WsTransportConnectionState): void {
  switch (state.kind) {
    case "connected":
      noteConnectionHealthConnected();
      return;
    case "disconnected":
      noteConnectionHealthDisconnected(state.error ?? null);
      return;
    case "reconnecting":
      noteConnectionHealthReconnecting(state.error ?? null);
      return;
    case "reconnected":
      noteConnectionHealthReconnected();
      return;
  }
}

export function resetConnectionHealthForTests(): void {
  snapshot = { ...initialSnapshot, lastChangedAt: Date.now() };
  connectionInterruptedToastId = null;
  connectionHealthToastsEnabled = false;
  listeners.clear();
}
