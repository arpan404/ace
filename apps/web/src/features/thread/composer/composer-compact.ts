import { createContext, useContext } from "react";

/** The composer is narrow: footer controls drop their labels to icons and keep tooltips. */
export const ComposerCompact = createContext(false);

export function useComposerCompact(): boolean {
  return useContext(ComposerCompact);
}
