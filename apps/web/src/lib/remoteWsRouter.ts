import { type FilesystemBrowseInput, type FilesystemBrowseResult } from "@ace/contracts";
import { normalizeWsUrl, splitWsUrlAuthToken } from "@ace/shared/hostConnections";
import { RelayRpcTransport } from "@ace/shared/relayRpcTransport";
import { parseRelayConnectionUrl } from "@ace/shared/relay";

import { reportBackgroundError } from "./async";
import { createWsRpcClient, getWsRpcClient, type WsRpcClient } from "../wsRpcClient";
import { loadWebRelayDeviceIdentity } from "./relayDeviceIdentity";
import { resolveWebSecureRelayConnectionUrl } from "./relaySecureStorage";
import { WsTransport } from "../wsTransport";
import { resolveLocalDeviceWsUrl } from "./remoteHosts";

const routeClientsByConnectionUrl = new Map<string, WsRpcClient>();
const routeClientRelayListenerCleanupByConnectionUrl = new Map<string, () => void>();
const routeAvailabilityByConnectionUrl = new Map<string, RemoteRouteAvailabilitySnapshot>();
const routeRegistrationCountByConnectionUrl = new Map<string, number>();
const inFlightAvailabilityByConnectionUrl = new Map<
  string,
  Promise<RemoteRouteAvailabilitySnapshot>
>();
const remoteRelayConnectionStateListeners = new Set<
  (event: RemoteRelayConnectionStateEvent) => void
>();
let disposeHandlersRegistered = false;
type RemoteDispatchCommand = Parameters<WsRpcClient["orchestration"]["dispatchCommand"]>[0];
type RemoteSnapshotInput = Parameters<WsRpcClient["orchestration"]["getSnapshot"]>[0];
type RemoteSnapshotResult = Awaited<ReturnType<WsRpcClient["orchestration"]["getSnapshot"]>>;
const inFlightSnapshotRequestByKey = new Map<string, Promise<RemoteSnapshotResult>>();
const DEFAULT_ROUTE_PROBE_TIMEOUT_MS = 2_500;
const ROUTE_AVAILABILITY_MAX_AGE_MS = 3_000;

export interface RemoteRouteAvailabilitySnapshot {
  readonly status: "unknown" | "checking" | "available" | "unavailable";
  readonly checkedAt: number;
  readonly error?: string;
}

export interface RemoteRelayConnectionStateEvent {
  readonly connectionUrl: string;
  readonly kind: "disconnected" | "reconnected";
  readonly error?: string;
}

function normalizeConnectionUrl(connectionUrl: string): string {
  return normalizeWsUrl(connectionUrl);
}

function normalizeConnectionEndpointUrl(connectionUrl: string): string {
  return normalizeWsUrl(splitWsUrlAuthToken(connectionUrl).wsUrl);
}

function createRouteClientSessionId(): string {
  const randomSuffix =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `route-${randomSuffix}`;
}

function createRouteConnectionId(): string {
  const randomSuffix =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `route-connection-${randomSuffix}`;
}

function isActiveConnectionUrl(connectionUrl: string): boolean {
  return (
    normalizeConnectionEndpointUrl(connectionUrl) ===
    normalizeConnectionEndpointUrl(resolveLocalDeviceWsUrl())
  );
}

function resolveRouteAvailability(connectionUrl: string): RemoteRouteAvailabilitySnapshot {
  const normalizedConnectionUrl = normalizeConnectionUrl(connectionUrl);
  return (
    routeAvailabilityByConnectionUrl.get(normalizedConnectionUrl) ?? {
      status: "unknown",
      checkedAt: 0,
    }
  );
}

function setRouteAvailability(
  connectionUrl: string,
  snapshot: RemoteRouteAvailabilitySnapshot,
): RemoteRouteAvailabilitySnapshot {
  const normalizedConnectionUrl = normalizeConnectionUrl(connectionUrl);
  routeAvailabilityByConnectionUrl.set(normalizedConnectionUrl, snapshot);
  return snapshot;
}

function emitRemoteRelayConnectionState(event: RemoteRelayConnectionStateEvent): void {
  for (const listener of remoteRelayConnectionStateListeners) {
    try {
      listener(event);
    } catch {
      // Ignore listener failures so remote route state remains stable.
    }
  }
}

function ensureRouteTracked(connectionUrl: string): string {
  const normalizedConnectionUrl = normalizeConnectionUrl(connectionUrl);
  if (!routeAvailabilityByConnectionUrl.has(normalizedConnectionUrl)) {
    routeAvailabilityByConnectionUrl.set(normalizedConnectionUrl, {
      status: "unknown",
      checkedAt: 0,
    });
  }
  return normalizedConnectionUrl;
}

function isRouteAvailabilityFresh(snapshot: RemoteRouteAvailabilitySnapshot): boolean {
  return Date.now() - snapshot.checkedAt <= ROUTE_AVAILABILITY_MAX_AGE_MS;
}

function ensureDisposeHandlersRegistered(): void {
  if (
    disposeHandlersRegistered ||
    typeof window === "undefined" ||
    typeof window.addEventListener !== "function"
  ) {
    return;
  }
  const disposeClients = () => {
    void disposeAllRemoteRouteClients();
  };
  window.addEventListener("pagehide", disposeClients, { once: true });
  window.addEventListener("beforeunload", disposeClients, { once: true });
  disposeHandlersRegistered = true;
}

function getOrCreateRouteClient(connectionUrl: string): WsRpcClient {
  const normalizedConnectionUrl = normalizeConnectionUrl(connectionUrl);
  if (isActiveConnectionUrl(normalizedConnectionUrl)) {
    return getWsRpcClient();
  }
  const existingClient = routeClientsByConnectionUrl.get(normalizedConnectionUrl);
  if (existingClient) {
    return existingClient;
  }
  ensureDisposeHandlersRegistered();
  const relayMetadata = parseRelayConnectionUrl(normalizedConnectionUrl);
  const createdClient = relayMetadata
    ? (() => {
        const transport = new RelayRpcTransport({
          connectionUrl: normalizedConnectionUrl,
          clientSessionId: createRouteClientSessionId(),
          connectionId: createRouteConnectionId(),
          deviceName: "ace web",
          loadIdentity: loadWebRelayDeviceIdentity,
          resolveConnectionUrl: resolveWebSecureRelayConnectionUrl,
        });
        routeClientRelayListenerCleanupByConnectionUrl.set(
          normalizedConnectionUrl,
          transport.onConnectionStateChange((state) => {
            if (state.kind === "disconnected") {
              setRouteAvailability(normalizedConnectionUrl, {
                status: "unavailable",
                checkedAt: Date.now(),
                ...(state.error ? { error: state.error } : {}),
              });
              clearInFlightSnapshotRequestsForConnection(normalizedConnectionUrl);
              inFlightAvailabilityByConnectionUrl.delete(normalizedConnectionUrl);
            } else {
              setRouteAvailability(normalizedConnectionUrl, {
                status: "available",
                checkedAt: Date.now(),
              });
            }
            emitRemoteRelayConnectionState({
              connectionUrl: normalizedConnectionUrl,
              kind: state.kind,
              ...(state.error ? { error: state.error } : {}),
            });
          }),
        );
        return createWsRpcClient(transport);
      })()
    : createWsRpcClient(
        new WsTransport(normalizedConnectionUrl, {
          clientSessionId: createRouteClientSessionId(),
          disableConnectionProbeLifecycle: true,
        }),
      );
  routeClientsByConnectionUrl.set(normalizedConnectionUrl, createdClient);
  return createdClient;
}

async function disposeRouteClientOnly(normalizedConnectionUrl: string): Promise<void> {
  routeClientRelayListenerCleanupByConnectionUrl.get(normalizedConnectionUrl)?.();
  routeClientRelayListenerCleanupByConnectionUrl.delete(normalizedConnectionUrl);
  const client = routeClientsByConnectionUrl.get(normalizedConnectionUrl);
  if (!client) {
    return;
  }
  routeClientsByConnectionUrl.delete(normalizedConnectionUrl);
  await client.dispose();
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

function snapshotRequestKey(connectionUrl: string, input: RemoteSnapshotInput): string {
  let encodedInput = "";
  if (input !== undefined) {
    try {
      encodedInput = JSON.stringify(input);
    } catch {
      encodedInput = "__nonserializable__";
    }
  }
  return `${connectionUrl}:${encodedInput}`;
}

function clearInFlightSnapshotRequestsForConnection(connectionUrl: string): void {
  const prefix = `${connectionUrl}:`;
  for (const requestKey of inFlightSnapshotRequestByKey.keys()) {
    if (!requestKey.startsWith(prefix)) {
      continue;
    }
    inFlightSnapshotRequestByKey.delete(requestKey);
  }
}

export function registerRemoteRoute(connectionUrl: string): void {
  const normalizedConnectionUrl = ensureRouteTracked(connectionUrl);
  routeRegistrationCountByConnectionUrl.set(
    normalizedConnectionUrl,
    (routeRegistrationCountByConnectionUrl.get(normalizedConnectionUrl) ?? 0) + 1,
  );
}

export function getRouteRpcClient(connectionUrl: string): WsRpcClient {
  ensureRouteTracked(connectionUrl);
  return getOrCreateRouteClient(connectionUrl);
}

export function unregisterRemoteRoute(connectionUrl: string): void {
  const normalizedConnectionUrl = normalizeConnectionUrl(connectionUrl);
  const registrationCount = routeRegistrationCountByConnectionUrl.get(normalizedConnectionUrl) ?? 0;
  if (registrationCount > 1) {
    routeRegistrationCountByConnectionUrl.set(normalizedConnectionUrl, registrationCount - 1);
    return;
  }
  routeRegistrationCountByConnectionUrl.delete(normalizedConnectionUrl);
  routeAvailabilityByConnectionUrl.delete(normalizedConnectionUrl);
  inFlightAvailabilityByConnectionUrl.delete(normalizedConnectionUrl);
  clearInFlightSnapshotRequestsForConnection(normalizedConnectionUrl);
  void disposeRouteClientOnly(normalizedConnectionUrl).catch((error) => {
    reportBackgroundError("Failed to dispose an unregistered remote route client.", error);
  });
}

export function readRemoteRouteAvailability(
  connectionUrl: string,
): RemoteRouteAvailabilitySnapshot {
  return resolveRouteAvailability(connectionUrl);
}

export function subscribeToRemoteRelayConnectionState(
  listener: (event: RemoteRelayConnectionStateEvent) => void,
): () => void {
  remoteRelayConnectionStateListeners.add(listener);
  return () => {
    remoteRelayConnectionStateListeners.delete(listener);
  };
}

async function probeRemoteRouteOverExistingClient(
  connectionUrl: string,
  timeoutMs: number,
): Promise<void> {
  const normalizedConnectionUrl = normalizeConnectionUrl(connectionUrl);
  const client = getOrCreateRouteClient(normalizedConnectionUrl);
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      client.server.getConfig().then(() => undefined),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`Remote host probe timed out after ${String(timeoutMs)}ms.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
    }
  }
}

export async function probeRemoteRouteAvailability(
  connectionUrl: string,
  options?: {
    readonly timeoutMs?: number;
    readonly force?: boolean;
  },
): Promise<RemoteRouteAvailabilitySnapshot> {
  const normalizedConnectionUrl = normalizeConnectionUrl(connectionUrl);
  const current = resolveRouteAvailability(normalizedConnectionUrl);
  if (!options?.force && current.status !== "unknown" && isRouteAvailabilityFresh(current)) {
    return current;
  }
  const existingProbe = inFlightAvailabilityByConnectionUrl.get(normalizedConnectionUrl);
  if (existingProbe) {
    return existingProbe;
  }

  const timeoutMs = Math.max(1_000, options?.timeoutMs ?? DEFAULT_ROUTE_PROBE_TIMEOUT_MS);
  setRouteAvailability(normalizedConnectionUrl, {
    status: "checking",
    checkedAt: Date.now(),
  });

  const probePromise = probeRemoteRouteOverExistingClient(normalizedConnectionUrl, timeoutMs)
    .then(() =>
      setRouteAvailability(normalizedConnectionUrl, {
        status: "available",
        checkedAt: Date.now(),
      }),
    )
    .catch((error) => {
      return setRouteAvailability(normalizedConnectionUrl, {
        status: "unavailable",
        checkedAt: Date.now(),
        error: getErrorMessage(error),
      });
    })
    .finally(() => {
      inFlightAvailabilityByConnectionUrl.delete(normalizedConnectionUrl);
    });
  inFlightAvailabilityByConnectionUrl.set(normalizedConnectionUrl, probePromise);
  return probePromise;
}

export async function routeFilesystemBrowseToRemote(
  connectionUrl: string,
  input: FilesystemBrowseInput,
): Promise<FilesystemBrowseResult> {
  const normalizedConnectionUrl = ensureRouteTracked(connectionUrl);
  const client = getOrCreateRouteClient(normalizedConnectionUrl);
  try {
    const result = await client.filesystem.browse(input);
    setRouteAvailability(normalizedConnectionUrl, {
      status: "available",
      checkedAt: Date.now(),
    });
    return result;
  } catch (error) {
    setRouteAvailability(normalizedConnectionUrl, {
      status: "unavailable",
      checkedAt: Date.now(),
      error: getErrorMessage(error),
    });
    throw error;
  }
}

export async function routeOrchestrationDispatchCommandToRemote(
  connectionUrl: string,
  command: RemoteDispatchCommand,
): Promise<void> {
  const normalizedConnectionUrl = ensureRouteTracked(connectionUrl);
  const client = getOrCreateRouteClient(normalizedConnectionUrl);
  try {
    await client.orchestration.dispatchCommand(command);
    setRouteAvailability(normalizedConnectionUrl, {
      status: "available",
      checkedAt: Date.now(),
    });
  } catch (error) {
    setRouteAvailability(normalizedConnectionUrl, {
      status: "unavailable",
      checkedAt: Date.now(),
      error: getErrorMessage(error),
    });
    throw error;
  }
}

export async function routeOrchestrationGetSnapshotFromRemote(
  connectionUrl: string,
  input?: RemoteSnapshotInput,
): Promise<RemoteSnapshotResult> {
  const normalizedConnectionUrl = ensureRouteTracked(connectionUrl);
  const requestKey = snapshotRequestKey(normalizedConnectionUrl, input);
  const inFlightRequest = inFlightSnapshotRequestByKey.get(requestKey);
  if (inFlightRequest) {
    return inFlightRequest;
  }
  const client = getOrCreateRouteClient(normalizedConnectionUrl);
  const requestPromise = (async () => {
    try {
      const snapshot = await client.orchestration.getSnapshot(input);
      setRouteAvailability(normalizedConnectionUrl, {
        status: "available",
        checkedAt: Date.now(),
      });
      return snapshot;
    } catch (error) {
      setRouteAvailability(normalizedConnectionUrl, {
        status: "unavailable",
        checkedAt: Date.now(),
        error: getErrorMessage(error),
      });
      throw error;
    } finally {
      inFlightSnapshotRequestByKey.delete(requestKey);
    }
  })();
  inFlightSnapshotRequestByKey.set(requestKey, requestPromise);
  return requestPromise;
}

export async function disposeRemoteRouteClient(connectionUrl: string): Promise<void> {
  const normalizedConnectionUrl = normalizeConnectionUrl(connectionUrl);
  routeRegistrationCountByConnectionUrl.delete(normalizedConnectionUrl);
  unregisterRemoteRoute(normalizedConnectionUrl);
  await disposeRouteClientOnly(normalizedConnectionUrl);
}

export async function disposeAllRemoteRouteClients(): Promise<void> {
  routeRegistrationCountByConnectionUrl.clear();
  routeAvailabilityByConnectionUrl.clear();
  inFlightAvailabilityByConnectionUrl.clear();
  inFlightSnapshotRequestByKey.clear();
  for (const cleanup of routeClientRelayListenerCleanupByConnectionUrl.values()) {
    cleanup();
  }
  routeClientRelayListenerCleanupByConnectionUrl.clear();
  const clients = [...routeClientsByConnectionUrl.values()];
  routeClientsByConnectionUrl.clear();
  await Promise.all(clients.map((client) => client.dispose()));
}
