import { createContext, useContext } from "react";
import type { PrWorkspaceExtensions } from "./pr-extensions.ts";

export const PrWorkspaceExtensionProvider = createContext<PrWorkspaceExtensions | undefined>(
  undefined,
);
export const usePrWorkspaceExtensions = () => useContext(PrWorkspaceExtensionProvider);
