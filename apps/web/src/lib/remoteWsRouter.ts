import { type FilesystemBrowseInput, type FilesystemBrowseResult } from "@ace/contracts";
import { normalizeWsUrl } from "@ace/shared/hostConnections";

import { createWsRpcClient, getWsRpcClient, type WsRpcClient } from "../wsRpcClient";
import { WsTransport } from "../wsTransport";
import { resolveActiveWsUrl } from "./remoteHosts";

const routeClientsByConnectionUrl = new Map<string, WsRpcClient>();
const routeAvailabilityByConnectionUrl = new Map<string, RemoteRouteAvailabilitySnapshot>();
const inFlightAvailabilityByConnectionUrl = new Map<
  string,
  Promise<RemoteRouteAvailabilitySnapshot>
>();
let disposeHandlersRegistered = false;
type RemoteDispatchCommand = Parameters<WsRpcClient["orchestration"]["dispatchCommand"]>[0];
type RemoteSnapshotInput = Parameters<WsRpcClient["orchestration"]["getSnapshot"]>[0];
type RemoteSnapshotResult = Awaited<ReturnType<WsRpcClient["orchestration"]["getSnapshot"]>>;
const DEFAULT_ROUTE_PROBE_TIMEOUT_MS = 2_500;
const ROUTE_AVAILABILITY_MAX_AGE_MS = 3_000;

export interface RemoteRouteAvailabilitySnapshot {
  readonly status: "unknown" | "checking" | "available" | "unavailable";
  readonly checkedAt: number;
  readonly error?: string;
}

function normalizeConnectionUrl(connectionUrl: string): string {
  return normalizeWsUrl(connectionUrl);
}

function createRouteClientSessionId(connectionUrl: string): string {
  const randomSuffix =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `route:${normalizeConnectionUrl(connectionUrl)}:${randomSuffix}`;
}

function isActiveConnectionUrl(connectionUrl: string): boolean {
  return normalizeConnectionUrl(connectionUrl) === normalizeConnectionUrl(resolveActiveWsUrl());
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
  const createdClient = createWsRpcClient(
    new WsTransport(normalizedConnectionUrl, {
      clientSessionId: createRouteClientSessionId(normalizedConnectionUrl),
    }),
  );
  routeClientsByConnectionUrl.set(normalizedConnectionUrl, createdClient);
  return createdClient;
}

async function disposeRouteClientOnly(normalizedConnectionUrl: string): Promise<void> {
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

export function registerRemoteRoute(connectionUrl: string): void {
  const normalizedConnectionUrl = normalizeConnectionUrl(connectionUrl);
  getOrCreateRouteClient(normalizedConnectionUrl);
}

export function unregisterRemoteRoute(connectionUrl: string): void {
  const normalizedConnectionUrl = normalizeConnectionUrl(connectionUrl);
  routeAvailabilityByConnectionUrl.delete(normalizedConnectionUrl);
  inFlightAvailabilityByConnectionUrl.delete(normalizedConnectionUrl);
}

export function readRemoteRouteAvailability(
  connectionUrl: string,
): RemoteRouteAvailabilitySnapshot {
  return resolveRouteAvailability(connectionUrl);
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
  registerRemoteRoute(connectionUrl);
  const normalizedConnectionUrl = normalizeConnectionUrl(connectionUrl);
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
  registerRemoteRoute(connectionUrl);
  const normalizedConnectionUrl = normalizeConnectionUrl(connectionUrl);
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
  registerRemoteRoute(connectionUrl);
  const normalizedConnectionUrl = normalizeConnectionUrl(connectionUrl);
  const client = getOrCreateRouteClient(normalizedConnectionUrl);
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
  }
}

export async function disposeRemoteRouteClient(connectionUrl: string): Promise<void> {
  const normalizedConnectionUrl = normalizeConnectionUrl(connectionUrl);
  unregisterRemoteRoute(normalizedConnectionUrl);
  await disposeRouteClientOnly(normalizedConnectionUrl);
}

export async function disposeAllRemoteRouteClients(): Promise<void> {
  routeAvailabilityByConnectionUrl.clear();
  inFlightAvailabilityByConnectionUrl.clear();
  const clients = [...routeClientsByConnectionUrl.values()];
  routeClientsByConnectionUrl.clear();
  await Promise.all(clients.map((client) => client.dispose()));
}
