import AsyncStorage from "@react-native-async-storage/async-storage";
import { parseRelayConnectionUrl, relayConnectionStorageKey } from "@ace/shared/relay";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { HostInstance } from "../hostInstances";
import { connectionManager } from "../rpc/ConnectionManager";
import {
  deleteMobileRelayConnectionSecrets,
  persistMobileRelayConnectionSecrets,
  resolveMobileSecureRelayConnectionUrl,
} from "../relaySecureStorage";

interface HostState {
  hosts: HostInstance[];
  activeHostId: string | null;
  addHost: (host: HostInstance) => void;
  updateHost: (host: HostInstance) => void;
  removeHost: (id: string) => void;
  setActiveHost: (id: string | null) => void;
}

function isLegacyPlaceholderHost(host: HostInstance): boolean {
  return (
    host.name === "Primary ace host" &&
    host.authToken.trim().length === 0 &&
    host.lastConnectedAt === undefined
  );
}

function parsePersistedSnapshot(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function extractPersistedHostUrls(value: string | null): string[] {
  if (!value) {
    return [];
  }
  const parsed = parsePersistedSnapshot(value);
  if (!parsed || typeof parsed.state !== "object" || parsed.state === null) {
    return [];
  }
  const state = parsed.state as { hosts?: unknown };
  if (!Array.isArray(state.hosts)) {
    return [];
  }
  return state.hosts.flatMap((host) => {
    if (typeof host !== "object" || host === null) {
      return [];
    }
    const candidate = host as { wsUrl?: unknown };
    return typeof candidate.wsUrl === "string" ? [candidate.wsUrl] : [];
  });
}

function persistedHostIdentity(wsUrl: string): string {
  const relayMetadata = parseRelayConnectionUrl(wsUrl);
  if (!relayMetadata) {
    return `direct:${wsUrl}`;
  }
  return `relay:${relayConnectionStorageKey(relayMetadata)}`;
}

async function transformPersistedHosts(
  value: string,
  transformWsUrl: (wsUrl: string) => Promise<string>,
): Promise<string> {
  const parsed = parsePersistedSnapshot(value);
  if (!parsed || typeof parsed.state !== "object" || parsed.state === null) {
    return value;
  }
  const state = parsed.state as { hosts?: unknown };
  if (!Array.isArray(state.hosts)) {
    return value;
  }
  let changed = false;
  const nextHosts = await Promise.all(
    state.hosts.map(async (host) => {
      if (typeof host !== "object" || host === null) {
        return host;
      }
      const candidate = host as Record<string, unknown>;
      if (typeof candidate.wsUrl !== "string") {
        return host;
      }
      const nextWsUrl = await transformWsUrl(candidate.wsUrl);
      if (nextWsUrl === candidate.wsUrl) {
        return host;
      }
      changed = true;
      return {
        ...candidate,
        wsUrl: nextWsUrl,
      };
    }),
  );
  if (!changed) {
    return value;
  }
  return JSON.stringify({
    ...parsed,
    state: {
      ...state,
      hosts: nextHosts,
    },
  });
}

const relayAwareHostStoreStorage = {
  getItem: async (name: string) => {
    const value = await AsyncStorage.getItem(name);
    if (!value) {
      return null;
    }
    return transformPersistedHosts(value, resolveMobileSecureRelayConnectionUrl);
  },
  setItem: async (name: string, value: string) => {
    const previousValue = await AsyncStorage.getItem(name);
    const persistedValue = await transformPersistedHosts(
      value,
      persistMobileRelayConnectionSecrets,
    );
    const previousIdentities = new Map(
      extractPersistedHostUrls(previousValue).map((wsUrl) => [persistedHostIdentity(wsUrl), wsUrl]),
    );
    const nextIdentities = new Set(
      extractPersistedHostUrls(persistedValue).map((wsUrl) => persistedHostIdentity(wsUrl)),
    );
    await Promise.all(
      [...previousIdentities.entries()]
        .filter(([identity]) => !nextIdentities.has(identity))
        .map(([, wsUrl]) => deleteMobileRelayConnectionSecrets(wsUrl)),
    );
    return AsyncStorage.setItem(name, persistedValue);
  },
  removeItem: async (name: string) => {
    const previousValue = await AsyncStorage.getItem(name);
    await Promise.all(
      extractPersistedHostUrls(previousValue).map((wsUrl) =>
        deleteMobileRelayConnectionSecrets(wsUrl),
      ),
    );
    return AsyncStorage.removeItem(name);
  },
};

export const useHostStore = create<HostState>()(
  persist(
    (set) => ({
      hosts: [],
      activeHostId: null,
      addHost: (host: HostInstance) => {
        set((state: HostState) => ({
          hosts: [...state.hosts.filter((h: HostInstance) => h.id !== host.id), host],
          activeHostId: state.activeHostId ?? host.id,
        }));
        // Auto-connect after adding
        void connectionManager.connect(host);
      },
      updateHost: (host: HostInstance) => {
        set((state: HostState) => ({
          hosts: state.hosts.map((currentHost) =>
            currentHost.id === host.id ? host : currentHost,
          ),
        }));
        void connectionManager.connect(host);
      },
      removeHost: (id: string) => {
        set((state: HostState) => ({
          hosts: state.hosts.filter((h: HostInstance) => h.id !== id),
          activeHostId:
            state.activeHostId === id
              ? (state.hosts.find((host) => host.id !== id)?.id ?? null)
              : state.activeHostId,
        }));
        void connectionManager.disconnect(id);
      },
      setActiveHost: (id: string | null) => set({ activeHostId: id }),
    }),
    {
      name: "ace-hosts-storage",
      storage: createJSONStorage(() => relayAwareHostStoreStorage),
      onRehydrateStorage: () => (_state, error) => {
        if (error) {
          return;
        }
        const current = useHostStore.getState();
        const nextHosts =
          current.hosts.length === 1 &&
          current.hosts[0] &&
          isLegacyPlaceholderHost(current.hosts[0])
            ? []
            : current.hosts;
        const nextActiveHostId = nextHosts.some((host) => host.id === current.activeHostId)
          ? current.activeHostId
          : (nextHosts[0]?.id ?? null);
        if (nextHosts !== current.hosts || nextActiveHostId !== current.activeHostId) {
          useHostStore.setState({
            hosts: nextHosts,
            activeHostId: nextActiveHostId,
          });
        }
        for (const host of nextHosts) {
          void connectionManager.connect(host);
        }
      },
    },
  ),
);

// Initialize connections on startup
export async function initializeConnections() {
  const state = useHostStore.getState();
  for (const host of state.hosts) {
    await connectionManager.connect(host);
  }
}
