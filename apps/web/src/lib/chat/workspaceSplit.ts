export const WORKSPACE_EDITOR_SPLIT_WIDTH_STORAGE_KEY = "ace:workspace:editor-split-width:v1";
export const DEFAULT_WORKSPACE_EDITOR_SPLIT_WIDTH = 760;
export const MIN_WORKSPACE_EDITOR_SPLIT_WIDTH = 420;
export const MIN_WORKSPACE_CHAT_SPLIT_WIDTH = 420;

export function clampWorkspaceEditorSplitWidth(width: number, viewportWidth: number): number {
  const safeViewportWidth = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 0;
  const maxWidth = Math.max(
    MIN_WORKSPACE_EDITOR_SPLIT_WIDTH,
    safeViewportWidth - MIN_WORKSPACE_CHAT_SPLIT_WIDTH,
  );
  const normalizedWidth = Number.isFinite(width)
    ? Math.round(width)
    : DEFAULT_WORKSPACE_EDITOR_SPLIT_WIDTH;
  return Math.min(maxWidth, Math.max(MIN_WORKSPACE_EDITOR_SPLIT_WIDTH, normalizedWidth));
}
