import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { HostInstance } from "../hostInstances";
import { connectionManager } from "../rpc/ConnectionManager";

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
      storage: createJSONStorage(() => AsyncStorage),
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
