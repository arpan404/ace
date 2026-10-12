import { createContext, use, useMemo, type ReactNode } from "react";
import { useScopeWorkspace, useWorkspaceActions } from "@/lib/workspace/index.ts";

const emptySections: Record<string, boolean> = {};
const Context = createContext<{
  state: { sections: Record<string, boolean> };
  update(patch: { sections: Record<string, boolean> }): void;
} | null>(null);

/** Environment folds belong to the current Work tab's view preferences. */
export function WorkStateProvider(props: { scope: string; children: ReactNode }) {
  const workspace = useScopeWorkspace(props.scope);
  const actions = useWorkspaceActions(props.scope);
  const sections = workspace.tabs.find((tab) => tab.key === "work")?.ui?.sections ?? emptySections;
  const value = useMemo(
    () => ({
      state: { sections },
      update: (patch: { sections: Record<string, boolean> }) =>
        actions.updateUi("work", { sections: { ...sections, ...patch.sections } }),
    }),
    [sections, actions],
  );
  return <Context value={value}>{props.children}</Context>;
}

export function useWorkState() {
  const value = use(Context);
  if (!value) throw new Error("Work state requires its provider");
  return value;
}
