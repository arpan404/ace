/** The side panel's model, store and tab-kind registry. See apps/web/README.md. */
export type { OpenTab, WorkspaceActions } from "./actions.ts";
export { useWorkspaceCommands, type WorkspaceCommand } from "./commands.ts";
export {
  findTab,
  shownTab,
  tabKey,
  type OpenRequest,
  type ScopeWorkspace,
  type WorkspaceTab,
} from "./model.ts";
export {
  defineWorkspace,
  type WorkspaceDefinition,
  type WorkspaceDefinitionOptions,
} from "./definition.ts";
export {
  defineTabKind,
  type ClosingTab,
  type CloseWarning,
  type TabKind,
  type TabKindOptions,
  type TabModule,
  type TabViewProps,
} from "./registry.ts";
export {
  useFocusedScope,
  usePreferredSize,
  useScopeWorkspace,
  useWorkspaceActions,
  useWorkspaceStore,
} from "./react.tsx";
export { defaultSize, WorkspaceStore, type ClosedTab } from "./store.ts";

export { fileTab, fileTabId } from "./file-tab.ts";
