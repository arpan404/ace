import { createContext } from "react";

/**
 * Whether a select sits in a settings row: there it takes the row's shared minimum and grows to
 * its longest option, up to the column. Elsewhere it keeps its own width.
 */
export const SelectSizesToOptions = createContext(false);
