import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { HostInstance } from "../hostInstances";
import { connectionManager } from "../rpc/ConnectionManager";

interface HostState {
  hosts: HostInstance[];
  activeHostId: string | null;
  addHost: (host: HostInstance) => void;
  removeHost: (id: string) => void;
  setActiveHost: (id: string | null) => void;
}

export const useHostStore = create<HostState>()(
  persist(
    (set) => ({
      hosts: [],
      activeHostId: null,
      addHost: (host: HostInstance) => {
        set((state: HostState) => ({
          hosts: [...state.hosts.filter((h: HostInstance) => h.id !== host.id), host],
        }));
        // Auto-connect after adding
        void connectionManager.connect(host);
      },
      removeHost: (id: string) => {
        set((state: HostState) => ({
          hosts: state.hosts.filter((h: HostInstance) => h.id !== id),
          activeHostId: state.activeHostId === id ? null : state.activeHostId,
        }));
        void connectionManager.disconnect(id);
      },
      setActiveHost: (id: string | null) => set({ activeHostId: id }),
    }),
    {
      name: "ace-hosts-storage",
      storage: createJSONStorage(() => AsyncStorage),
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
