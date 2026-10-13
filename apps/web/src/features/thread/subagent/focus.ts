import { createContext, useContext } from "react";

/**
 * The provider subagent a screen shows, when it shows one rather than its whole thread. Its
 * route sets it around the screen, so the details card beside it can say where it sits.
 */
const SubagentFocus = createContext<string | undefined>(undefined);
export const SubagentFocusProvider = SubagentFocus.Provider;
export const useSubagentFocus = () => useContext(SubagentFocus);
