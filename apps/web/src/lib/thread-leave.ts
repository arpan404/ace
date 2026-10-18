import { createContext, useContext } from "react";

/**
 * Where the person goes once the open thread leaves the list (archived from its own screen):
 * the next thread in the sidebar's order, with the caret in its composer. The app layer
 * provides it from the thread list (`features/home`); without one, a thread steps back to Home.
 */
export const ThreadLeaveContext = createContext<((threadId: string) => void) | undefined>(
  undefined,
);

/** The leave step the app provides, or undefined when none is. */
export function useThreadLeave(): ((threadId: string) => void) | undefined {
  return useContext(ThreadLeaveContext);
}
