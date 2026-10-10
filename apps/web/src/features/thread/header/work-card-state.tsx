import { createContext, use, useMemo, type ReactNode } from "react";
import {
  useScopeWorkspace,
  useWorkspaceActions,
  type WorkCardState,
} from "@/lib/workspace/index.ts";

const defaults: WorkCardState = { open: false, sections: {}, search: "" };
const Context = createContext<{
  state: WorkCardState;
  update(patch: Partial<WorkCardState>): void;
} | null>(null);

/** One bounded workspace subscription owns the card's per-thread view state. */
export function WorkCardStateProvider(props: { scope: string; children: ReactNode }) {
  const workspace = useScopeWorkspace(props.scope);
  const actions = useWorkspaceActions(props.scope);
  const state = workspace.workCard ?? defaults;
  const value = useMemo(() => ({ state, update: actions.setWorkCard }), [state, actions]);
  return <Context value={value}>{props.children}</Context>;
}

export function useWorkCardState() {
  const value = use(Context);
  if (!value) throw new Error("Work card state requires its provider");
  return value;
}
