import type { QueuedComposerTerminalContext } from "@ace/contracts";
import { create } from "zustand";

interface MobileTerminalContextState {
  readonly contextsByThreadId: Readonly<Record<string, readonly QueuedComposerTerminalContext[]>>;
  readonly addThreadContext: (threadId: string, context: QueuedComposerTerminalContext) => void;
  readonly clearThreadContexts: (threadId: string) => void;
  readonly removeThreadContext: (
    threadId: string,
    contextId: QueuedComposerTerminalContext["id"],
  ) => void;
  readonly setThreadContexts: (
    threadId: string,
    contexts: ReadonlyArray<QueuedComposerTerminalContext>,
  ) => void;
}

export const useMobileTerminalContextStore = create<MobileTerminalContextState>((set) => ({
  contextsByThreadId: {},
  addThreadContext: (threadId, context) =>
    set((state) => {
      const existing = state.contextsByThreadId[threadId] ?? [];
      const nextContexts = [
        ...existing.filter((candidate) => candidate.id !== context.id),
        context,
      ].slice(-4);
      return {
        contextsByThreadId: {
          ...state.contextsByThreadId,
          [threadId]: nextContexts,
        },
      };
    }),
  clearThreadContexts: (threadId) =>
    set((state) => {
      if (!state.contextsByThreadId[threadId]) {
        return state;
      }
      const { [threadId]: _removed, ...rest } = state.contextsByThreadId;
      return { contextsByThreadId: rest };
    }),
  removeThreadContext: (threadId, contextId) =>
    set((state) => {
      const existing = state.contextsByThreadId[threadId] ?? [];
      const nextContexts = existing.filter((context) => context.id !== contextId);
      if (nextContexts.length === existing.length) {
        return state;
      }
      if (nextContexts.length === 0) {
        const { [threadId]: _removed, ...rest } = state.contextsByThreadId;
        return { contextsByThreadId: rest };
      }
      return {
        contextsByThreadId: {
          ...state.contextsByThreadId,
          [threadId]: nextContexts,
        },
      };
    }),
  setThreadContexts: (threadId, contexts) =>
    set((state) => {
      if (contexts.length === 0) {
        const { [threadId]: _removed, ...rest } = state.contextsByThreadId;
        return { contextsByThreadId: rest };
      }
      return {
        contextsByThreadId: {
          ...state.contextsByThreadId,
          [threadId]: contexts.slice(-4),
        },
      };
    }),
}));
