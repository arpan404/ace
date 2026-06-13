import type { EditorLineNumbers } from "@ace/contracts";

const WORKSPACE_EDITOR_FONT_FAMILY =
  '"SF Mono", "SFMono-Regular", ui-monospace, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

export interface WorkspaceEditorSettingsSnapshot {
  readonly lineNumbers: EditorLineNumbers;
  readonly renderWhitespace: boolean;
  readonly stickyScroll: boolean;
  readonly wordWrap: boolean;
}

export interface WorkspaceCodeEditorOptions {
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly lineNumbers: EditorLineNumbers;
  readonly renderWhitespace: boolean;
  readonly suggestions: boolean;
  readonly tabSize: number;
  readonly wordWrap: boolean;
}

export function createWorkspaceEditorOptions(
  editorSettings: WorkspaceEditorSettingsSnapshot,
): WorkspaceCodeEditorOptions {
  return {
    fontFamily: WORKSPACE_EDITOR_FONT_FAMILY,
    fontSize: 13,
    lineHeight: 22,
    lineNumbers: editorSettings.lineNumbers,
    renderWhitespace: editorSettings.renderWhitespace,
    suggestions: true,
    tabSize: 2,
    wordWrap: editorSettings.wordWrap,
  };
}

export function createWorkspaceDiffEditorOptions(): WorkspaceCodeEditorOptions {
  return {
    fontFamily: WORKSPACE_EDITOR_FONT_FAMILY,
    fontSize: 13,
    lineHeight: 22,
    lineNumbers: "on",
    renderWhitespace: false,
    suggestions: false,
    tabSize: 2,
    wordWrap: true,
  };
}
