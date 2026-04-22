import type { EditorLineNumbers } from "@ace/contracts";
import type { editor as MonacoEditor } from "monaco-editor";

const WORKSPACE_EDITOR_FONT_FAMILY =
  '"SF Mono", "SFMono-Regular", ui-monospace, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

const WORKSPACE_EDITOR_SCROLLBAR = {
  horizontalScrollbarSize: 14,
  useShadows: false,
  verticalScrollbarSize: 14,
} as const;

export interface WorkspaceEditorSettingsSnapshot {
  readonly lineNumbers: EditorLineNumbers;
  readonly minimap: boolean;
  readonly renderWhitespace: boolean;
  readonly stickyScroll: boolean;
  readonly suggestions: boolean;
  readonly wordWrap: boolean;
}

export function createWorkspaceEditorOptions(
  editorSettings: WorkspaceEditorSettingsSnapshot,
): MonacoEditor.IStandaloneEditorConstructionOptions {
  return {
    acceptSuggestionOnCommitCharacter: editorSettings.suggestions,
    acceptSuggestionOnEnter: editorSettings.suggestions ? ("smart" as const) : ("off" as const),
    autoClosingBrackets: "always" as const,
    autoClosingComments: "always" as const,
    autoClosingDelete: "always" as const,
    autoClosingOvertype: "always" as const,
    autoClosingQuotes: "always" as const,
    autoIndent: "advanced" as const,
    automaticLayout: true,
    bracketPairColorization: { enabled: true },
    cursorBlinking: "blink" as const,
    cursorSmoothCaretAnimation: "off" as const,
    cursorSurroundingLines: 2,
    fontFamily: WORKSPACE_EDITOR_FONT_FAMILY,
    fontLigatures: false,
    fontSize: 13,
    lineHeight: 22,
    letterSpacing: 0,
    formatOnPaste: true,
    formatOnType: true,
    guides: {
      bracketPairs: true,
      highlightActiveBracketPair: true,
      indentation: true,
    },
    inlineSuggest: { enabled: editorSettings.suggestions },
    lineNumbers: editorSettings.lineNumbers,
    matchBrackets: "always" as const,
    minimap: { enabled: editorSettings.minimap },
    mouseWheelZoom: true,
    occurrencesHighlight: "singleFile" as const,
    padding: { bottom: 0, top: 0 },
    parameterHints: { enabled: editorSettings.suggestions },
    quickSuggestions: editorSettings.suggestions
      ? ({
          comments: false,
          other: true,
          strings: true,
        } as const)
      : false,
    renderLineHighlightOnlyWhenFocus: false,
    renderWhitespace: editorSettings.renderWhitespace ? ("all" as const) : ("none" as const),
    roundedSelection: false,
    scrollbar: WORKSPACE_EDITOR_SCROLLBAR,
    scrollBeyondLastLine: false,
    smoothScrolling: false,
    snippetSuggestions: editorSettings.suggestions ? ("top" as const) : ("none" as const),
    stickyScroll: { enabled: editorSettings.stickyScroll },
    suggest: {
      localityBonus: true,
      preview: true,
      previewMode: "subwordSmart" as const,
      selectionMode: "whenTriggerCharacter" as const,
      showInlineDetails: true,
      showStatusBar: true,
      snippetsPreventQuickSuggestions: false,
    },
    suggestOnTriggerCharacters: editorSettings.suggestions,
    suggestSelection: editorSettings.suggestions
      ? ("recentlyUsedByPrefix" as const)
      : ("first" as const),
    tabCompletion: editorSettings.suggestions ? ("on" as const) : ("off" as const),
    tabSize: 2,
    wordBasedSuggestions: editorSettings.suggestions
      ? ("matchingDocuments" as const)
      : ("off" as const),
    wordWrap: editorSettings.wordWrap ? ("on" as const) : ("off" as const),
  };
}

export function createWorkspaceDiffEditorOptions(): MonacoEditor.IDiffEditorConstructionOptions {
  return {
    automaticLayout: true,
    minimap: { enabled: false },
    originalEditable: false,
    readOnly: true,
    renderSideBySide: true,
  };
}
