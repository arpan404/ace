type WsClientSessionRecord = {
  readonly connectionId: string;
  readonly generation: number;
  readonly updatedAt: number;
};

const WS_CLIENT_SESSION_TTL_MS = 15 * 60_000;
const WS_CLIENT_SESSION_PRUNE_INTERVAL_MS = 60_000;

const wsClientSessions = new Map<string, WsClientSessionRecord>();
let nextWsClientSessionPruneAt = 0;

function pruneWsClientSessions(now = Date.now()): void {
  for (const [clientSessionId, record] of wsClientSessions.entries()) {
    if (record.updatedAt + WS_CLIENT_SESSION_TTL_MS <= now) {
      wsClientSessions.delete(clientSessionId);
    }
  }
}

export function pruneWsClientSessionsIfNeeded(now = Date.now()): void {
  if (now < nextWsClientSessionPruneAt) {
    return;
  }
  pruneWsClientSessions(now);
  nextWsClientSessionPruneAt = now + WS_CLIENT_SESSION_PRUNE_INTERVAL_MS;
}

export function hasActiveWsClientSessions(now = Date.now()): boolean {
  pruneWsClientSessionsIfNeeded(now);
  return wsClientSessions.size > 0;
}

export function registerWsClientSession(
  clientSessionId: string,
  connectionId: string,
  now = Date.now(),
): void {
  pruneWsClientSessionsIfNeeded(now);
  const existing = wsClientSessions.get(clientSessionId);
  const nextRecord: WsClientSessionRecord =
    existing && existing.connectionId === connectionId
      ? {
          ...existing,
          updatedAt: now,
        }
      : {
          connectionId,
          generation: (existing?.generation ?? 0) + 1,
          updatedAt: now,
        };
  wsClientSessions.set(clientSessionId, nextRecord);
}

export function isCurrentWsClientSession(clientSessionId?: string, connectionId?: string): boolean {
  if (!clientSessionId || !connectionId) {
    return true;
  }
  const now = Date.now();
  pruneWsClientSessionsIfNeeded(now);
  const current = wsClientSessions.get(clientSessionId);
  if (!current) {
    registerWsClientSession(clientSessionId, connectionId, now);
    return true;
  }
  if (current.connectionId !== connectionId) {
    return false;
  }
  wsClientSessions.set(clientSessionId, {
    ...current,
    updatedAt: now,
  });
  return true;
}

export function disconnectWsClientSession(clientSessionId: string, connectionId: string): void {
  const current = wsClientSessions.get(clientSessionId);
  if (current?.connectionId === connectionId) {
    wsClientSessions.delete(clientSessionId);
  }
}
