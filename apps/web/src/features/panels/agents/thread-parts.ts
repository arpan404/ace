import type { TurnActivity } from "@ace/ui-core";
import { createContext, useContext, type ComponentType, type ReactNode } from "react";

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
  /**
   * The thread's next git step (Commit & push, Push, Create PR) with every step behind its
   * chevron: the same control the thread details card shows, for the Changes header.
   */
  gitAction?: ComponentType<{ threadId: string; className?: string | undefined }> | undefined;
  /**
   * Reads the turn's one live line (`turnActivity`) as the transcript's live head reads it and
   * hands it to `children`, so the Summary's head line can never disagree with it.
   */
  turnActivity?:
    | ComponentType<{
        threadId: string;
        children(activity: TurnActivity | undefined): ReactNode;
      }>
    | undefined;
  /** Move focus to the request waiting on the person in the composer's strip. */
  showRequest?: (() => void) | undefined;
}

const ThreadPartsContext = createContext<ThreadParts>({});
export const ThreadPartsProvider = ThreadPartsContext.Provider;

/** The parts provided above this tab (empty outside a thread screen). */
export function useThreadParts(): ThreadParts {
  return useContext(ThreadPartsContext);
}
