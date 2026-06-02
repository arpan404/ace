import type { ThreadId } from "@ace/contracts";
import { useSyncExternalStore } from "react";

import type { BrowserSessionStorage } from "./session";

type BrowserSessionListener = () => void;

const browserSessionListeners = new Set<BrowserSessionListener>();
let browserSessionByThreadId: Record<string, BrowserSessionStorage> = {};

function emitBrowserSessionChange(): void {
  for (const listener of browserSessionListeners) {
    listener();
  }
}

function subscribeToBrowserSessionStore(listener: BrowserSessionListener): () => void {
  browserSessionListeners.add(listener);
  return () => {
    browserSessionListeners.delete(listener);
  };
}

export function getBrowserSession(
  threadId: ThreadId | string | null | undefined,
): BrowserSessionStorage | null {
  if (!threadId) {
    return null;
  }
  return browserSessionByThreadId[String(threadId)] ?? null;
}

export function setBrowserSession(
  threadId: ThreadId | string,
  session: BrowserSessionStorage,
): void {
  if (browserSessionByThreadId[threadId] === session) {
    return;
  }
  browserSessionByThreadId = {
    ...browserSessionByThreadId,
    [threadId]: session,
  };
  emitBrowserSessionChange();
}

export function deleteBrowserSession(threadId: ThreadId | string): void {
  if (!browserSessionByThreadId[threadId]) {
    return;
  }
  const nextBrowserSessionByThreadId = { ...browserSessionByThreadId };
  delete nextBrowserSessionByThreadId[threadId];
  browserSessionByThreadId = nextBrowserSessionByThreadId;
  emitBrowserSessionChange();
}

export function clearBrowserSessions(): void {
  if (Object.keys(browserSessionByThreadId).length === 0) {
    return;
  }
  browserSessionByThreadId = {};
  emitBrowserSessionChange();
}

export function useBrowserSession(
  threadId: ThreadId | string | null | undefined,
): BrowserSessionStorage | null {
  return useSyncExternalStore(
    subscribeToBrowserSessionStore,
    () => getBrowserSession(threadId),
    () => null,
  );
}
