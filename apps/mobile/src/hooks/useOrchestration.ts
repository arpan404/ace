import { useCallback, useEffect, useState } from "react";
import type { ManagedConnection } from "../rpc/ConnectionManager";
import type { OrchestrationReadModel } from "@ace/contracts";

/**
 * Hook to subscribe to a specific connection's orchestration snapshot
 */
export function useOrchestrationSnapshot(connection: ManagedConnection | null) {
  const [snapshot, setSnapshot] = useState<OrchestrationReadModel | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connectionId = connection?.host.id ?? null;
  const connectionStatus = connection?.status.kind ?? "disconnected";

  const refresh = useCallback(async () => {
    if (!connection) {
      setSnapshot(undefined);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const snap = await connection.client.orchestration.getSnapshot();
      setSnapshot(snap);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [connection]);

  useEffect(() => {
    void refresh();
    if (!connection) {
      return;
    }

    // Subscribe to updates
    const unsubscribe = connection.client.orchestration.onDomainEvent(() => {
      // Refresh snapshot when events arrive
      connection.client.orchestration
        .getSnapshot()
        .then((snap) => {
          setSnapshot(snap);
        })
        .catch((err) => {
          setError(err instanceof Error ? err.message : String(err));
        });
    });

    return () => {
      unsubscribe?.();
    };
  }, [connection, connectionId, connectionStatus, refresh]);

  return { snapshot, loading, error, refresh };
}

/**
 * Hook to execute an orchestration command with loading state
 */
export function useOrchestrationCommand(connection: ManagedConnection | null) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const execute = async (fn: () => Promise<void>) => {
    if (!connection || connection.status.kind !== "connected") {
      setError("Not connected");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return { execute, loading, error };
}
