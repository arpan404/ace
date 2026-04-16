import { create } from "zustand";
import type { OrchestrationThread, OrchestrationProject } from "@ace/contracts";

interface SessionState {
  // Current active session
  activeHostId: string | null;
  activeThreadId: string | null;
  activeProjectId: string | null;

  // UI state
  currentTab: "home" | "chat" | "projects" | "control" | "settings";
  isLoading: boolean;
  error: string | null;

  // Data cache
  threads: OrchestrationThread[];
  projects: OrchestrationProject[];

  // Actions
  setActiveHost: (hostId: string | null) => void;
  setActiveThread: (threadId: string | null) => void;
  setActiveProject: (projectId: string | null) => void;
  setCurrentTab: (tab: SessionState["currentTab"]) => void;
  setIsLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setThreads: (threads: OrchestrationThread[]) => void;
  setProjects: (projects: OrchestrationProject[]) => void;
  reset: () => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  activeHostId: null,
  activeThreadId: null,
  activeProjectId: null,
  currentTab: "home",
  isLoading: false,
  error: null,
  threads: [],
  projects: [],

  setActiveHost: (hostId) => set({ activeHostId: hostId }),
  setActiveThread: (threadId) => set({ activeThreadId: threadId }),
  setActiveProject: (projectId) => set({ activeProjectId: projectId }),
  setCurrentTab: (tab) => set({ currentTab: tab }),
  setIsLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),
  setThreads: (threads) => set({ threads }),
  setProjects: (projects) => set({ projects }),
  reset: () =>
    set({
      activeHostId: null,
      activeThreadId: null,
      activeProjectId: null,
      isLoading: false,
      error: null,
    }),
}));
