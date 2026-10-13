import { createContext, useContext } from "react";

/**
 * Pieces of other slices a workspace tab draws with, handed down by whoever renders the thread
 * screen. The thread slice reaches the panels, so the panels can't import it back.
 * Each is optional; a tab without its part says what it can't show here.
 */
export interface ThreadParts {
  /**
   * Fork the thread from its latest finished turn (opens the fork form); undefined until a
   * turn has finished.
   */
  fork?: (() => void) | undefined;
}

const ThreadPartsContext = createContext<ThreadParts>({});
export const ThreadPartsProvider = ThreadPartsContext.Provider;

/** The parts provided above this tab (empty outside a thread screen). */
export function useThreadParts(): ThreadParts {
  return useContext(ThreadPartsContext);
}
