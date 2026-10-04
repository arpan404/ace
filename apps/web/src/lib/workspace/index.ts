/** The workspace docks' model, store and tab-kind registry. See apps/web/README.md. */
export type { OpenTab, WorkspaceActions } from "./actions.ts";
export {
  docks,
  findTab,
  shownTab,
  tabKey,
  type Dock,
  type DockState,
  type OpenRequest,
  type ScopeWorkspace,
  type WorkspaceTab,
} from "./model.ts";
export {
  defineWorkspace,
  type DockPlus,
  type WorkspaceDefinition,
  type WorkspaceDefinitionOptions,
} from "./definition.ts";
export {
  defineTabKind,
  type TabKind,
  type TabKindOptions,
  type TabModule,
  type TabViewProps,
} from "./registry.ts";
export {
  useFocusedScope,
  usePreferredSizes,
  useScopeWorkspace,
  useWorkspaceActions,
  useWorkspaceStore,
} from "./react.tsx";
export { defaultSizes, WorkspaceStore, type PreferredSizes } from "./store.ts";
