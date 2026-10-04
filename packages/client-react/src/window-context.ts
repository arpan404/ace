import type { ThreadSource } from "@ace/client";
import { createContext, createElement, useContext, type ReactNode } from "react";

const WindowContext = createContext<{ threadId: string; source: ThreadSource } | undefined>(
  undefined,
);

/**
 * Inside, hooks reading `threadId` (`useThread`, `useItem`, `useItemOrder`, ...) read `source`
 * instead of the live tail; with no source they read the tail as usual. The live lease is
 * held either way, so the subscription never drops while a window is shown.
 */
export function ThreadWindowProvider(props: {
  threadId: string;
  source: ThreadSource | undefined;
  children?: ReactNode;
}) {
  const value = props.source ? { threadId: props.threadId, source: props.source } : undefined;
  return createElement(WindowContext.Provider, { value }, props.children);
}

export function useThreadWindow(threadId: string | undefined): ThreadSource | undefined {
  const window = useContext(WindowContext);
  return window && window.threadId === threadId ? window.source : undefined;
}
