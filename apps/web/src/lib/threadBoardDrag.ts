import type { ThreadId } from "@ace/contracts";

import { buildThreadBoardThreadKey, normalizeThreadBoardConnectionUrl } from "./threadBoardThreads";

export interface ThreadBoardDragThread {
  connectionUrl: string | null;
  sourcePaneId?: string | null;
  threadId: ThreadId;
  title?: string | null | undefined;
}

const activeThreadBoardDragListeners = new Set<() => void>();
let activeThreadBoardDrag: ThreadBoardDragThread | null = null;

export const THREAD_BOARD_DRAG_MIME = "application/x-ace-thread-board";

export function createThreadBoardDragThread(input: {
  connectionUrl?: string | null;
  sourcePaneId?: string | null;
  threadId: ThreadId;
  title?: string | null | undefined;
}): ThreadBoardDragThread {
  return {
    connectionUrl: normalizeThreadBoardConnectionUrl(input.connectionUrl),
    ...(input.sourcePaneId ? { sourcePaneId: input.sourcePaneId } : {}),
    ...(input.title?.trim() ? { title: input.title.trim() } : {}),
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
    ...(input.sourcePaneId ? { sourcePaneId: input.sourcePaneId } : {}),
    ...(input.title?.trim() ? { title: input.title.trim() } : {}),
    threadId: input.threadId,
  });
}

export function decodeThreadBoardDragThread(value: string): ThreadBoardDragThread | null {
  try {
    const parsed = JSON.parse(value) as {
      connectionUrl?: string | null;
      sourcePaneId?: string | null;
      threadId?: string;
      title?: string | null;
    };
    if (!parsed || typeof parsed.threadId !== "string" || parsed.threadId.length === 0) {
      return null;
    }
    return {
      connectionUrl: normalizeThreadBoardConnectionUrl(parsed.connectionUrl),
      ...(typeof parsed.sourcePaneId === "string" && parsed.sourcePaneId.length > 0
        ? { sourcePaneId: parsed.sourcePaneId }
        : {}),
      ...(typeof parsed.title === "string" && parsed.title.trim().length > 0
        ? { title: parsed.title.trim() }
        : {}),
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

export function setThreadBoardDragImage(
  dataTransfer: DataTransfer,
  input?: {
    label?: string | null;
    tone?: "copy" | "move";
  },
): void {
  if (typeof document === "undefined") {
    return;
  }

  const element = document.createElement("div");
  const label = input?.label?.trim() || (input?.tone === "copy" ? "Add thread" : "Move pane");
  element.textContent = label.length > 42 ? `${label.slice(0, 39)}...` : label;
  element.style.cssText = [
    "position: fixed",
    "top: 0",
    "left: 0",
    "z-index: 2147483647",
    "transform: translate(-10000px, -10000px)",
    "max-width: 260px",
    "overflow: hidden",
    "text-overflow: ellipsis",
    "white-space: nowrap",
    "border-radius: 999px",
    "border: 1px solid color-mix(in srgb, var(--border) 80%, var(--primary) 20%)",
    "background: color-mix(in srgb, var(--background) 92%, transparent)",
    "box-shadow: 0 12px 30px color-mix(in srgb, var(--foreground) 12%, transparent)",
    "color: var(--foreground)",
    "font: 500 12px/1.2 var(--font-ui)",
    "letter-spacing: var(--ui-letter-spacing)",
    "padding: 7px 10px",
    "pointer-events: none",
    "backdrop-filter: blur(12px)",
  ].join(";");

  document.body.appendChild(element);
  dataTransfer.setDragImage(element, 14, 14);
  requestAnimationFrame(() => {
    element.remove();
  });
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
