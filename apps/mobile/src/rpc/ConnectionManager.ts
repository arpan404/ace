import {
  createMobileWsClient,
  type MobileWsClient,
  type MobileWsClientConnectionState,
} from "./mobileWsClient";
import type { HostInstance } from "../hostInstances";

export interface ManagedConnection {
  host: HostInstance;
  client: MobileWsClient;
  status: MobileWsClientConnectionState;
  cleanup: () => void;
}

function shouldRecreateConnection(current: HostInstance, next: HostInstance): boolean {
  return (
    current.wsUrl !== next.wsUrl ||
    current.authToken !== next.authToken ||
    current.clientSessionId !== next.clientSessionId
  );
}

export class ConnectionManager {
  private connections = new Map<string, ManagedConnection>();
  private statusListeners = new Set<(connections: ManagedConnection[]) => void>();

  async connect(
    host: HostInstance,
    options?: { readonly forceReconnect?: boolean },
  ): Promise<MobileWsClient> {
    const existing = this.connections.get(host.id);
    if (existing) {
      if (options?.forceReconnect || shouldRecreateConnection(existing.host, host)) {
        existing.cleanup();
        this.connections.delete(host.id);
      } else {
        if (existing.host !== host) {
          existing.host = host;
          this.notify();
        }
        return existing.client;
      }
    }

    const client = createMobileWsClient({
      url: host.wsUrl,
      authToken: host.authToken,
      clientSessionId: host.clientSessionId,
    });

    const cleanupStatus = client.onConnectionStateChange((status) => {
      const conn = this.connections.get(host.id);
      if (conn) {
        conn.status = status;
        this.notify();
      }
    });

    const managed: ManagedConnection = {
      host,
      client,
      status: { kind: "disconnected" },
      cleanup: () => {
        cleanupStatus();
        void client.dispose();
      },
    };

    this.connections.set(host.id, managed);
    void client.server.getConfig().catch(() => {
      // Keep the managed connection in disconnected state when initial probe fails.
    });
    this.notify();
    return client;
  }

  async disconnect(hostId: string): Promise<void> {
    const conn = this.connections.get(hostId);
    if (conn) {
      conn.cleanup();
      this.connections.delete(hostId);
      this.notify();
    }
  }

  async disconnectAll(): Promise<void> {
    for (const conn of this.connections.values()) {
      conn.cleanup();
    }
    this.connections.clear();
    this.notify();
  }

  getConnections(): ManagedConnection[] {
    return Array.from(this.connections.values());
  }

  onStatusChange(listener: (connections: ManagedConnection[]) => void): () => void {
    this.statusListeners.add(listener);
    try {
      listener(this.getConnections());
    } catch {
      // Listener errors must not break subscriber registration.
    }
    return () => this.statusListeners.delete(listener);
  }

  private notify(): void {
    const conns = this.getConnections();
    for (const listener of this.statusListeners) {
      try {
        listener(conns);
      } catch {
        // Listener errors must not break other listeners.
      }
    }
  }
}

export const connectionManager = new ConnectionManager();
