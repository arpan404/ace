import type { ForkPoint } from "@ace/protocol";
import { createContext, use } from "react";

/**
 * Opens the fork dialog at a point, its first message prefilled with `text` when given (an edit
 * of the person's message); provided by the thread screen, used by its messages.
 */
export const ForkOpener = createContext<((point: ForkPoint, text?: string) => void) | undefined>(
  undefined,
);
export const useForkOpener = () => use(ForkOpener);
