import { createContext } from "react";
import type { agentTreeWork } from "@ace/ui-core";

export type TreeWork = ReturnType<typeof agentTreeWork>;
export const TreeWorkContext = createContext<TreeWork>({ running: new Set(), needsYou: new Set() });
