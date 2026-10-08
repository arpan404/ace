import { createContext } from "react";

/**
 * The item a jump or a search hit landed on, if any. A work log holding it opens, so what the
 * agent said between steps (which reads inside the log) shows where the jump lands.
 */
export const JumpedItem = createContext<string | undefined>(undefined);
