import type { ThreadId } from "@ace/contracts";

import { buildThreadBoardThreadKey, normalizeThreadBoardConnectionUrl } from "./threadBoardThreads";

export interface ThreadBoardDragThread {
  connectionUrl: string | null;
  threadId: ThreadId;
}

const activeThreadBoardDragListeners = new Set<() => void>();
let activeThreadBoardDrag: ThreadBoardDragThread | null = null;

export const THREAD_BOARD_DRAG_MIME = "application/x-ace-thread-board";

export function createThreadBoardDragThread(input: {
  connectionUrl?: string | null;
  threadId: ThreadId;
}): ThreadBoardDragThread {
  return {
    connectionUrl: normalizeThreadBoardConnectionUrl(input.connectionUrl),
    threadId: input.threadId,
  };
}

export function getThreadBoardDragThreadKey(input: {
  connectionUrl?: string | null;
  threadId: ThreadId;
}): string {
  return buildThreadBoardThreadKey(input.threadId, input.connectionUrl);
}

export function encodeThreadBoardDragThread(input: ThreadBoardDragThread): string {
  return JSON.stringify({
    connectionUrl: input.connectionUrl,
    threadId: input.threadId,
  });
}

export function decodeThreadBoardDragThread(value: string): ThreadBoardDragThread | null {
  try {
    const parsed = JSON.parse(value) as {
      connectionUrl?: string | null;
      threadId?: string;
    };
    if (!parsed || typeof parsed.threadId !== "string" || parsed.threadId.length === 0) {
      return null;
    }
    return {
      connectionUrl: normalizeThreadBoardConnectionUrl(parsed.connectionUrl),
      threadId: parsed.threadId as ThreadId,
    };
  } catch {
    return null;
  }
}

export function readThreadBoardDragThread(
  dataTransfer: DataTransfer,
): ThreadBoardDragThread | null {
  return decodeThreadBoardDragThread(
    dataTransfer.getData(THREAD_BOARD_DRAG_MIME) || dataTransfer.getData("text/plain"),
  );
}

export function getActiveThreadBoardDrag(): ThreadBoardDragThread | null {
  return activeThreadBoardDrag;
}

export function setActiveThreadBoardDrag(thread: ThreadBoardDragThread | null): void {
  activeThreadBoardDrag = thread;
  for (const listener of activeThreadBoardDragListeners) {
    listener();
  }
}

export function subscribeActiveThreadBoardDrag(listener: () => void): () => void {
  activeThreadBoardDragListeners.add(listener);
  return () => {
    activeThreadBoardDragListeners.delete(listener);
  };
}
