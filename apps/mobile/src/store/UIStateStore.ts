import { create } from "zustand";
import type { HostInstance } from "../hostInstances";

interface UIState {
  // Tab navigation
  currentTab: "home" | "chat" | "projects" | "control" | "settings";

  // Modals and overlays
  showHostSwitcher: boolean;

  // Selection state
  selectedProviderKey: string | null;

  // Terminal/log output
  terminalOutput: string;

  // Host and connection state
  activeHostId: string | null;

  // Actions
  setCurrentTab: (tab: UIState["currentTab"]) => void;
  setShowHostSwitcher: (show: boolean) => void;
  setSelectedProviderKey: (key: string | null) => void;
  appendTerminalOutput: (text: string) => void;
  clearTerminalOutput: () => void;
  setActiveHostId: (hostId: string | null) => void;
  reset: () => void;
}

export const useUIStateStore = create<UIState>((set) => ({
  currentTab: "home",
  showHostSwitcher: false,
  selectedProviderKey: null,
  terminalOutput: "",
  activeHostId: null,

  setCurrentTab: (tab) => set({ currentTab: tab }),
  setShowHostSwitcher: (show) => set({ showHostSwitcher: show }),
  setSelectedProviderKey: (key) => set({ selectedProviderKey: key }),
  appendTerminalOutput: (text) =>
    set((state) => ({
      terminalOutput: state.terminalOutput + text,
    })),
  clearTerminalOutput: () => set({ terminalOutput: "" }),
  setActiveHostId: (hostId) => set({ activeHostId: hostId }),
  reset: () =>
    set({
      currentTab: "home",
      showHostSwitcher: false,
      selectedProviderKey: null,
      terminalOutput: "",
      activeHostId: null,
    }),
}));

/**
 * Selector to get the active connection from stored hosts.
 * Pass the hosts array from useHostStore
 */
export function getActiveConnectionHost(
  hostId: string | null,
  hosts: HostInstance[],
): HostInstance | null {
  if (!hostId) return null;
  return hosts.find((h) => h.id === hostId) ?? null;
}
