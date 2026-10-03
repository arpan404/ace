import type { ForkPoint } from "@ace/protocol";
import { createContext, use } from "react";

/** Opens the fork dialog at a point; provided by the thread screen, used by its answers. */
export const ForkOpener = createContext<((point: ForkPoint) => void) | undefined>(undefined);
export const useForkOpener = () => use(ForkOpener);
