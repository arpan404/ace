/** The side and bottom panels' model, store and tab-kind registry. See apps/web/README.md. */
export type { OpenTab, WorkspaceActions } from "./actions.ts";
export { useWorkspaceCommands, type WorkspaceCommand } from "./commands.ts";
export {
  activateTab,
  closeTab,
  findTab,
  openTab,
  shownTab,
  tabKey,
  updateTab,
  type OpenRequest,
  type ScopeWorkspace,
  type WorkspaceTab,
  type TabUiState,
} from "./model.ts";
export {
  defineWorkspace,
  type WorkspaceDefinition,
  type WorkspaceDefinitionOptions,
} from "./definition.ts";
export {
  defineTabKind,
  launchRequest,
  type ClosingTab,
  type CloseWarning,
  type TabKind,
  type TabKindOptions,
  type TabModule,
  type TabViewProps,
} from "./registry.ts";
export {
  PanelPlaceContext,
  PanelRoomContext,
  useBottomFits,
  useBottomHeight,
  useFocusedScope,
  usePreferredPlace,
  usePreferredSize,
  useScopeWorkspace,
  useOptionalWorkspace,
  useOpenInDeck,
  useWorkspaceActions,
  useWorkspaceStore,
} from "./react.tsx";
export { defaultBottomSize, defaultSize, WorkspaceStore, type ClosedTab } from "./store.ts";
export { allTabs, bottomOf, isShowing, locateTab, placeOf, type PanelPlace } from "./places.ts";

export {
  deckKind,
  deckLayoutOf,
  deckRoom,
  findInDeck,
  groupIds,
  openInDeck,
  openInLayout,
  type DeckOpen,
  type DeckTarget,
  type OpenInDeckOptions,
} from "./deck-tab.ts";
export { requestReveal, settleReveal, useReveal, type Reveal } from "./deck-reveal.ts";
export { settleExplorerAsk, useExplorerAsk } from "./deck-explorer-ask.ts";
export { pullRequestTab, PullRequestTabData } from "./pull-request-tab.ts";
export {
  filePreviewTab,
  filePreviewTabData,
  filePreviewTabKind,
  type FilePreviewSource,
  type FilePreviewTabData,
} from "./file-preview-tab.ts";
export {
  TextEdits,
  TextEditsContext,
  textEditTab,
  textEditTabKind,
  type TextEditSession,
} from "./text-edit-tab.ts";
export { tabDragType } from "./drag.ts";

export { attachWorkspaceScroll } from "./scroll.ts";
