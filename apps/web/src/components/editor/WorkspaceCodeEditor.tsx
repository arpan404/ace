import type {
  WorkspaceEditorCompletionItem,
  WorkspaceEditorDiagnostic,
  WorkspaceEditorHoverContent,
  WorkspaceEditorHoverResult,
  WorkspaceEditorLocation,
} from "@ace/contracts";
import {
  autocompletion,
  closeBrackets,
  completionKeymap,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import {
  addCursorAbove,
  addCursorBelow,
  copyLineDown,
  copyLineUp,
  cursorMatchingBracket,
  defaultKeymap,
  deleteLine,
  history,
  historyKeymap,
  indentLess,
  indentMore,
  indentWithTab,
  insertNewlineAndIndent,
  toggleComment,
  undoSelection,
} from "@codemirror/commands";
import { foldGutter, foldKeymap, indentOnInput, indentUnit } from "@codemirror/language";
import {
  forEachDiagnostic,
  forceLinting,
  lintGutter,
  lintKeymap,
  linter,
  setDiagnostics,
  type Diagnostic as CodeMirrorDiagnostic,
} from "@codemirror/lint";
import {
  closeSearchPanel,
  findNext as cmFindNext,
  findPrevious as cmFindPrevious,
  highlightSelectionMatches,
  openSearchPanel,
  replaceAll as cmReplaceAll,
  replaceNext as cmReplaceNext,
  search,
  selectMatches as cmSelectMatches,
  setSearchQuery,
} from "@codemirror/search";
import { Compartment, EditorSelection, EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  highlightTrailingWhitespace,
  highlightWhitespace,
  hoverTooltip,
  keymap,
  rectangularSelection,
  type Panel,
  type KeyBinding,
  type Tooltip,
  type ViewUpdate,
} from "@codemirror/view";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type MutableRefObject,
} from "react";

import {
  createWorkspaceCodeMirrorTheme,
  createWorkspaceLanguageExtensions,
  createWorkspaceLineNumberExtension,
  setWorkspaceEditorReadOnly,
  workspaceDocOffsetFromPosition,
  workspacePositionFromOffset,
} from "~/lib/editor/workspaceCodeMirror";
import type { WorkspaceCodeEditorOptions } from "~/lib/editor/workspaceEditorOptions";
import {
  createWorkspaceShikiHighlightConfig,
  workspaceShikiHighlightSupport,
} from "~/lib/editor/workspaceShikiHighlight";
import {
  countWorkspaceFindMatches,
  createWorkspaceFindQuery,
  resolveWorkspaceFindSeed,
  type WorkspaceFindMatchSummary,
  type WorkspaceFindState,
} from "~/lib/editor/workspaceFind";
import { cn } from "~/lib/utils";

const COMPLETION_TRIGGER_CHARACTERS = new Set([".", "/", '"', "'", ":", "<", "@"]);
const COMPLETION_WORD_PATTERN = /[\w$.-]*$/u;
const COMPLETION_VALID_FOR_PATTERN = /^[\w$.-]*$/u;
const WORKSPACE_IDENTIFIER_CHARACTER_PATTERN = /[\p{L}\p{N}_$#]/u;
const workspaceDiagnosticHoverMouseByView = new WeakMap<
  EditorView,
  { readonly x: number; readonly y: number }
>();

export interface WorkspaceCodeEditorHandle {
  readonly closeFindQuery: () => void;
  readonly findNext: () => void;
  readonly findPrevious: () => void;
  readonly focus: () => void;
  readonly getFindSeed: () => string;
  readonly replaceAll: () => void;
  readonly replaceNext: () => void;
  readonly revealLocation: (location: WorkspaceEditorLocation) => void;
  readonly selectFindMatches: () => void;
  readonly setPosition: (position: { readonly column: number; readonly line: number }) => void;
  readonly triggerCompletion: () => void;
  readonly updateFindQuery: (state: WorkspaceFindState) => WorkspaceFindMatchSummary;
}

export interface WorkspaceCodeEditorSelection {
  readonly id: string;
  readonly left: number;
  readonly location: WorkspaceEditorLocation;
  readonly text: string;
  readonly top: number;
}

interface WorkspaceCodeEditorProps {
  readonly activeFilePath: string;
  readonly className?: string;
  readonly completionProvider?: (input: {
    readonly column: number;
    readonly contents: string;
    readonly line: number;
  }) => Promise<readonly WorkspaceEditorCompletionItem[]>;
  readonly diagnostics: readonly WorkspaceEditorDiagnostic[];
  readonly languageId: string | null | undefined;
  readonly onChange: (contents: string) => void;
  readonly onCursorLabelChange: (label: string) => void;
  readonly onDefinitionRequest: (input: {
    readonly column: number;
    readonly contents: string;
    readonly line: number;
  }) => void;
  readonly onFindRequest: (input: { readonly replace: boolean; readonly seed: string }) => void;
  readonly onFocus: () => void;
  readonly onHoverRequest: (input: {
    readonly column: number;
    readonly contents: string;
    readonly line: number;
  }) => Promise<WorkspaceEditorHoverResult | null>;
  readonly onSave: () => void;
  readonly onSelectionChange: (selection: WorkspaceCodeEditorSelection | null) => void;
  readonly onSymbolsChange: (contents: string) => void;
  readonly onToggleProblems: () => void;
  readonly options: WorkspaceCodeEditorOptions;
  readonly readOnly?: boolean;
  readonly resolvedTheme: "light" | "dark";
  readonly value: string;
}

interface WorkspaceCodeEditorCallbacks {
  readonly activeFilePath: string;
  readonly completionProvider?: WorkspaceCodeEditorProps["completionProvider"];
  readonly languageId: string | null | undefined;
  readonly onChange: WorkspaceCodeEditorProps["onChange"];
  readonly onCursorLabelChange: WorkspaceCodeEditorProps["onCursorLabelChange"];
  readonly onDefinitionRequest: WorkspaceCodeEditorProps["onDefinitionRequest"];
  readonly onFindRequest: WorkspaceCodeEditorProps["onFindRequest"];
  readonly onFocus: WorkspaceCodeEditorProps["onFocus"];
  readonly onHoverRequest: WorkspaceCodeEditorProps["onHoverRequest"];
  readonly onSave: WorkspaceCodeEditorProps["onSave"];
  readonly onSelectionChange: WorkspaceCodeEditorProps["onSelectionChange"];
  readonly onSymbolsChange: WorkspaceCodeEditorProps["onSymbolsChange"];
  readonly onToggleProblems: WorkspaceCodeEditorProps["onToggleProblems"];
}

interface WorkspaceCodeEditorCreateSnapshot {
  readonly languageId: string | null | undefined;
  readonly options: WorkspaceCodeEditorOptions;
  readonly readOnly: boolean;
  readonly resolvedTheme: WorkspaceCodeEditorProps["resolvedTheme"];
  readonly value: string;
}

interface WorkspaceCodeEditorTransientRefs {
  readonly syncingFromPropsRef: MutableRefObject<boolean>;
  readonly valueRef: MutableRefObject<string>;
}

function updateCallbacksRef(
  ref: MutableRefObject<WorkspaceCodeEditorCallbacks>,
  props: WorkspaceCodeEditorProps,
): void {
  ref.current = {
    activeFilePath: props.activeFilePath,
    completionProvider: props.completionProvider,
    languageId: props.languageId,
    onChange: props.onChange,
    onCursorLabelChange: props.onCursorLabelChange,
    onDefinitionRequest: props.onDefinitionRequest,
    onFindRequest: props.onFindRequest,
    onFocus: props.onFocus,
    onHoverRequest: props.onHoverRequest,
    onSave: props.onSave,
    onSelectionChange: props.onSelectionChange,
    onSymbolsChange: props.onSymbolsChange,
    onToggleProblems: props.onToggleProblems,
  };
}

function completionTypeFromLspKind(kind: string | undefined): string {
  const numericKind = Number.parseInt(kind ?? "", 10);
  switch (numericKind) {
    case 2:
      return "method";
    case 3:
    case 4:
      return "function";
    case 5:
      return "field";
    case 6:
      return "variable";
    case 7:
    case 22:
      return "class";
    case 8:
      return "interface";
    case 9:
      return "namespace";
    case 10:
      return "property";
    case 13:
    case 20:
      return "enum";
    case 14:
      return "keyword";
    case 15:
      return "snippet";
    case 21:
      return "constant";
    case 25:
      return "type";
    default:
      return "text";
  }
}

function toCodeMirrorCompletion(item: WorkspaceEditorCompletionItem): Completion {
  const completion: Completion = {
    apply: item.insertText ?? item.label,
    label: item.filterText ?? item.label,
    type: completionTypeFromLspKind(item.kind),
  };
  if (item.filterText && item.filterText !== item.label) {
    completion.displayLabel = item.label;
  }
  if (item.detail) {
    completion.detail = item.detail;
  }
  if (item.documentation) {
    completion.info = item.documentation;
  }
  return completion;
}

function shouldRequestCompletion(context: CompletionContext): boolean {
  if (context.explicit) {
    return true;
  }
  const previousCharacter =
    context.pos > 0 ? context.state.sliceDoc(context.pos - 1, context.pos) : "";
  if (COMPLETION_TRIGGER_CHARACTERS.has(previousCharacter)) {
    return true;
  }
  const word = context.matchBefore(COMPLETION_WORD_PATTERN);
  return word !== null && word.from < word.to;
}

function createCompletionSource(
  callbacksRef: MutableRefObject<WorkspaceCodeEditorCallbacks>,
): (context: CompletionContext) => Promise<CompletionResult | null> {
  return async (context) => {
    const callbacks = callbacksRef.current;
    if (!callbacks.completionProvider || !shouldRequestCompletion(context)) {
      return null;
    }

    const word = context.matchBefore(COMPLETION_WORD_PATTERN);
    const line = context.state.doc.lineAt(context.pos);
    try {
      if (context.aborted) {
        return null;
      }
      const items = await callbacks.completionProvider({
        column: Math.max(0, context.pos - line.from),
        contents: context.state.doc.toString(),
        line: Math.max(0, line.number - 1),
      });
      return context.aborted
        ? null
        : {
            from: word?.from ?? context.pos,
            options: items.map(toCodeMirrorCompletion),
            validFor: COMPLETION_VALID_FOR_PATTERN,
          };
    } catch {
      return null;
    }
  };
}

function createCompletionExtension(
  callbacksRef: MutableRefObject<WorkspaceCodeEditorCallbacks>,
  options: WorkspaceCodeEditorOptions,
): Extension {
  if (!options.suggestions) {
    return [];
  }
  return autocompletion({
    activateOnTyping: true,
    defaultKeymap: false,
    override: [createCompletionSource(callbacksRef)],
  });
}

function createWhitespaceExtension(options: WorkspaceCodeEditorOptions): Extension {
  return options.renderWhitespace ? highlightWhitespace() : [];
}

function diagnosticCodeLabel(code: WorkspaceEditorDiagnostic["code"]): string | null {
  if (code === undefined) {
    return null;
  }
  const label = String(code).trim();
  return label.length > 0 ? label : null;
}

function renderWorkspaceDiagnosticMessage(diagnostic: WorkspaceEditorDiagnostic): () => Node {
  const message = diagnostic.message.trim().length > 0 ? diagnostic.message : "Language diagnostic";
  const code = diagnosticCodeLabel(diagnostic.code);
  return () => {
    const wrapper = document.createElement("span");
    wrapper.className = `ace-workspace-diagnostic-message ace-workspace-diagnostic-message-${diagnostic.severity}`;

    const messageText = document.createElement("span");
    messageText.className = "ace-workspace-diagnostic-message-text";
    messageText.textContent = message;
    wrapper.append(messageText);

    if (code) {
      const codeText = document.createElement("span");
      codeText.className = "ace-workspace-diagnostic-message-code";
      codeText.textContent = code;
      wrapper.append(codeText);
    }

    return wrapper;
  };
}

function toCodeMirrorDiagnostics(
  state: EditorState,
  diagnostics: readonly WorkspaceEditorDiagnostic[],
): CodeMirrorDiagnostic[] {
  return diagnostics.map((diagnostic) => {
    const from = workspaceDocOffsetFromPosition({
      column: diagnostic.startColumn,
      doc: state.doc,
      line: diagnostic.startLine,
    });
    const rawTo = workspaceDocOffsetFromPosition({
      column: diagnostic.endColumn,
      doc: state.doc,
      line: diagnostic.endLine,
    });
    const to = Math.max(from + 1, rawTo);
    const result: CodeMirrorDiagnostic = {
      from,
      message: diagnostic.message.trim().length > 0 ? diagnostic.message : "Language diagnostic",
      renderMessage: renderWorkspaceDiagnosticMessage(diagnostic),
      severity: diagnostic.severity,
      to: Math.min(to, state.doc.length),
    };
    if (diagnostic.source) {
      result.source = diagnostic.source;
    }
    return result;
  });
}

function suppressCodeMirrorLintTooltip(): CodeMirrorDiagnostic[] {
  return null as unknown as CodeMirrorDiagnostic[];
}

function codeMirrorDiagnosticIntersectsPosition(input: {
  from: number;
  position: number;
  side: -1 | 1;
  to: number;
}): boolean {
  if (input.position < input.from || input.position > input.to) {
    return false;
  }
  return (
    input.from === input.to ||
    ((input.position > input.from || input.side > 0) &&
      (input.position < input.to || input.side < 0))
  );
}

function codeMirrorDiagnosticsAtPosition(
  state: EditorState,
  position: number,
  side: -1 | 1,
): CodeMirrorDiagnostic[] {
  const diagnostics: CodeMirrorDiagnostic[] = [];
  forEachDiagnostic(state, (diagnostic, from, to) => {
    if (
      codeMirrorDiagnosticIntersectsPosition({
        from,
        position,
        side,
        to,
      })
    ) {
      diagnostics.push(diagnostic);
    }
  });
  return diagnostics;
}

function createWorkspaceDiagnosticTooltipDom(
  view: EditorView,
  diagnostics: readonly CodeMirrorDiagnostic[],
): HTMLElement {
  const list = document.createElement("ul");
  list.className = "cm-tooltip-lint";
  for (const diagnostic of diagnostics) {
    const item = document.createElement("li");
    item.className = `cm-diagnostic cm-diagnostic-${diagnostic.severity}`;

    const text = document.createElement("span");
    text.className = "cm-diagnosticText";
    text.append(
      diagnostic.renderMessage
        ? diagnostic.renderMessage(view)
        : document.createTextNode(diagnostic.message),
    );
    item.append(text);

    if (diagnostic.source) {
      const source = document.createElement("div");
      source.className = "cm-diagnosticSource";
      source.textContent = diagnostic.source;
      item.append(source);
    }

    list.append(item);
  }
  return list;
}

function createWorkspaceDiagnosticHoverExtension(): Extension {
  return hoverTooltip(
    (view, position, side): Tooltip | null => {
      const diagnostics = codeMirrorDiagnosticsAtPosition(view.state, position, side);
      if (diagnostics.length === 0) {
        return null;
      }

      return {
        pos: position,
        above: false,
        clip: false,
        create() {
          return {
            dom: createWorkspaceDiagnosticTooltipDom(view, diagnostics),
            getCoords() {
              const mouse = workspaceDiagnosticHoverMouseByView.get(view);
              if (mouse) {
                return {
                  bottom: mouse.y,
                  left: mouse.x,
                  right: mouse.x,
                  top: mouse.y,
                };
              }
              return view.coordsAtPos(position) ?? view.dom.getBoundingClientRect();
            },
            offset: { x: 12, y: 12 },
            overlap: true,
          };
        },
      };
    },
    {
      hideOnChange: true,
      hoverTime: 250,
    },
  );
}

function isMacLikePlatform(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  return /\b(Mac|iPhone|iPad|iPod)\b/u.test(navigator.platform);
}

function shouldAddWorkspaceSelectionRange(event: MouseEvent): boolean {
  if (event.altKey && !event.shiftKey) {
    return true;
  }
  return isMacLikePlatform() ? event.metaKey : event.ctrlKey;
}

function isWorkspaceAddCursorClick(event: MouseEvent): boolean {
  return event.button === 0 && event.altKey && !event.shiftKey && !event.metaKey && !event.ctrlKey;
}

function isWorkspaceDefinitionClick(event: MouseEvent): boolean {
  if (event.button !== 0 || event.altKey || event.shiftKey) {
    return false;
  }
  return isMacLikePlatform() ? event.metaKey : event.ctrlKey;
}

function isWorkspaceIdentifierCharacter(character: string): boolean {
  return WORKSPACE_IDENTIFIER_CHARACTER_PATTERN.test(character);
}

function workspaceIdentifierRangeAt(
  state: EditorState,
  offset: number,
): { readonly from: number; readonly to: number } | null {
  if (state.doc.length === 0) {
    return null;
  }

  const clampedOffset = Math.max(0, Math.min(offset, state.doc.length));
  const codeMirrorWord = state.wordAt(Math.min(clampedOffset, Math.max(0, state.doc.length - 1)));
  if (codeMirrorWord && codeMirrorWord.from < codeMirrorWord.to) {
    return codeMirrorWord;
  }

  const line = state.doc.lineAt(clampedOffset);
  if (line.text.length === 0) {
    return null;
  }
  let lineOffset = Math.max(0, Math.min(clampedOffset - line.from, line.text.length - 1));
  if (
    !isWorkspaceIdentifierCharacter(line.text[lineOffset] ?? "") &&
    lineOffset > 0 &&
    isWorkspaceIdentifierCharacter(line.text[lineOffset - 1] ?? "")
  ) {
    lineOffset -= 1;
  }
  if (!isWorkspaceIdentifierCharacter(line.text[lineOffset] ?? "")) {
    return null;
  }

  let startOffset = lineOffset;
  while (startOffset > 0 && isWorkspaceIdentifierCharacter(line.text[startOffset - 1] ?? "")) {
    startOffset -= 1;
  }

  let endOffset = lineOffset + 1;
  while (
    endOffset < line.text.length &&
    isWorkspaceIdentifierCharacter(line.text[endOffset] ?? "")
  ) {
    endOffset += 1;
  }

  return {
    from: line.from + startOffset,
    to: line.from + endOffset,
  };
}

function workspaceLspRequestOffsetAt(state: EditorState, offset: number): number {
  const identifierRange = workspaceIdentifierRangeAt(state, offset);
  if (!identifierRange) {
    return Math.max(0, Math.min(offset, state.doc.length));
  }
  return Math.max(identifierRange.from, Math.min(offset, identifierRange.to - 1));
}

function cursorLabelForState(state: EditorState): string {
  const position = workspacePositionFromOffset({
    doc: state.doc,
    offset: state.selection.main.head,
  });
  return `Ln ${position.line + 1}, Col ${position.column + 1}`;
}

function selectionForState(
  view: EditorView,
  activeFilePath: string,
): WorkspaceCodeEditorSelection | null {
  const selection = view.state.selection.main;
  if (selection.empty) {
    return null;
  }

  const from = Math.min(selection.from, selection.to);
  const to = Math.max(selection.from, selection.to);
  const text = view.state.doc.sliceString(from, to);
  if (text.trim().length === 0) {
    return null;
  }

  const start = workspacePositionFromOffset({ doc: view.state.doc, offset: from });
  const end = workspacePositionFromOffset({ doc: view.state.doc, offset: to });
  const location: WorkspaceEditorLocation = {
    endColumn: end.column,
    endLine: end.line,
    relativePath: activeFilePath,
    startColumn: start.column,
    startLine: start.line,
  };
  const coords = view.coordsAtPos(from) ?? view.coordsAtPos(to);
  const bounds = view.dom.getBoundingClientRect();
  const left = coords ? coords.left - bounds.left + 8 : 24;
  const top = coords ? coords.bottom - bounds.top + 8 : 24;
  return {
    id: [
      activeFilePath,
      location.startLine + 1,
      location.startColumn + 1,
      location.endLine + 1,
      location.endColumn + 1,
    ].join(":"),
    left: Math.max(12, Math.min(left, Math.max(12, bounds.width - 96))),
    location,
    text,
    top: Math.max(12, Math.min(top, Math.max(12, bounds.height - 64))),
  };
}

function requestDefinitionAtPosition(
  view: EditorView,
  callbacksRef: MutableRefObject<WorkspaceCodeEditorCallbacks>,
  offset: number,
): boolean {
  const requestOffset = workspaceLspRequestOffsetAt(view.state, offset);
  const line = view.state.doc.lineAt(requestOffset);
  callbacksRef.current.onDefinitionRequest({
    column: Math.max(0, requestOffset - line.from),
    contents: view.state.doc.toString(),
    line: Math.max(0, line.number - 1),
  });
  return true;
}

function addWorkspaceCursorAtPosition(view: EditorView, offset: number): boolean {
  const cursorOffset = Math.max(0, Math.min(offset, view.state.doc.length));
  if (
    view.state.selection.ranges.some(
      (range) => range.empty && range.from === cursorOffset && range.to === cursorOffset,
    )
  ) {
    view.focus();
    return true;
  }

  const nextCursor = EditorSelection.cursor(cursorOffset);
  const sortedRanges = [...view.state.selection.ranges, nextCursor].toSorted(
    (left, right) => left.from - right.from || left.to - right.to,
  );
  const mainIndex = sortedRanges.indexOf(nextCursor);
  view.dispatch({
    selection: EditorSelection.create(sortedRanges, mainIndex),
    scrollIntoView: true,
    userEvent: "select.pointer",
  });
  view.focus();
  return true;
}

function appendWorkspaceHoverCodeBlock(parent: HTMLElement, code: string, language?: string): void {
  const wrapper = document.createElement("div");
  wrapper.className = "ace-workspace-hover-code";
  if (language) {
    const label = document.createElement("div");
    label.className = "ace-workspace-hover-code-language";
    label.textContent = language;
    wrapper.append(label);
  }
  const pre = document.createElement("pre");
  pre.textContent = code;
  wrapper.append(pre);
  parent.append(wrapper);
}

function appendWorkspaceHoverTextBlock(parent: HTMLElement, text: string): void {
  const block = document.createElement("div");
  block.className = "ace-workspace-hover-text";
  block.textContent = text;
  parent.append(block);
}

function appendWorkspaceMarkdownHoverContent(parent: HTMLElement, value: string): void {
  const lines = value.split("\n");
  let index = 0;
  let pendingTextLines: string[] = [];

  const flushText = () => {
    const text = pendingTextLines.join("\n").trim();
    pendingTextLines = [];
    if (text.length > 0) {
      appendWorkspaceHoverTextBlock(parent, text);
    }
  };

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const fenceMatch = /^```([^\s`]*)\s*$/u.exec(line.trim());
    if (!fenceMatch) {
      pendingTextLines.push(line);
      index += 1;
      continue;
    }

    flushText();
    const language = fenceMatch[1]?.trim();
    const codeLines: string[] = [];
    index += 1;
    while (index < lines.length && !/^```\s*$/u.test((lines[index] ?? "").trim())) {
      codeLines.push(lines[index] ?? "");
      index += 1;
    }
    if (index < lines.length) {
      index += 1;
    }
    appendWorkspaceHoverCodeBlock(
      parent,
      codeLines.join("\n").trimEnd(),
      language && language.length > 0 ? language : undefined,
    );
  }

  flushText();
}

function createWorkspaceHoverDom(contents: readonly WorkspaceEditorHoverContent[]): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "ace-workspace-hover-tooltip";
  for (const content of contents) {
    const section = document.createElement("div");
    section.className = "ace-workspace-hover-section";
    if (content.kind === "code") {
      appendWorkspaceHoverCodeBlock(section, content.value, content.language);
    } else if (content.kind === "markdown") {
      appendWorkspaceMarkdownHoverContent(section, content.value);
    } else {
      appendWorkspaceHoverTextBlock(section, content.value);
    }
    if (section.childElementCount > 0) {
      dom.append(section);
    }
  }
  return dom;
}

function resolveWorkspaceHoverTooltipRange(
  view: EditorView,
  result: WorkspaceEditorHoverResult,
  fallbackRange: { readonly from: number; readonly to: number },
  activeFilePath: string,
): { readonly from: number; readonly to: number } {
  if (result.location?.relativePath === activeFilePath) {
    return locationToSelection(view.state, result.location);
  }
  return fallbackRange;
}

function createHoverExtension(
  callbacksRef: MutableRefObject<WorkspaceCodeEditorCallbacks>,
): Extension {
  return hoverTooltip(
    async (view, offset): Promise<Tooltip | null> => {
      const callbacks = callbacksRef.current;
      const identifierRange = workspaceIdentifierRangeAt(view.state, offset);
      if (!identifierRange) {
        return null;
      }
      const requestOffset = workspaceLspRequestOffsetAt(view.state, offset);
      const line = view.state.doc.lineAt(requestOffset);
      const activeFilePath = callbacks.activeFilePath;
      const result = await callbacks.onHoverRequest({
        column: Math.max(0, requestOffset - line.from),
        contents: view.state.doc.toString(),
        line: Math.max(0, line.number - 1),
      });
      if (
        !result ||
        result.contents.length === 0 ||
        callbacksRef.current.activeFilePath !== activeFilePath
      ) {
        return null;
      }

      const range = resolveWorkspaceHoverTooltipRange(
        view,
        result,
        identifierRange,
        activeFilePath,
      );
      return {
        pos: range.from,
        end: Math.max(range.from + 1, range.to),
        above: false,
        arrow: true,
        create() {
          return {
            dom: createWorkspaceHoverDom(result.contents),
          };
        },
      };
    },
    {
      hideOnChange: true,
      hoverTime: 250,
    },
  );
}

function selectedTextForFind(state: EditorState): string | null {
  const selection = state.selection.main;
  if (selection.empty) {
    return null;
  }
  const text = state.sliceDoc(selection.from, selection.to);
  return text.includes("\n") ? null : text;
}

function currentWordForFind(state: EditorState): string | null {
  const word = state.wordAt(state.selection.main.head);
  return word ? state.sliceDoc(word.from, word.to) : null;
}

function findSeedForState(state: EditorState): string {
  return resolveWorkspaceFindSeed({
    currentWord: currentWordForFind(state),
    selectedText: selectedTextForFind(state),
  });
}

function createHiddenSearchPanel(): Panel {
  const dom = document.createElement("div");
  dom.className = "ace-workspace-hidden-search-panel";
  dom.setAttribute("aria-hidden", "true");
  return { dom };
}

function createKeymap(
  callbacksRef: MutableRefObject<WorkspaceCodeEditorCallbacks>,
): readonly KeyBinding[] {
  return [
    {
      key: "Mod-s",
      run() {
        callbacksRef.current.onSave();
        return true;
      },
    },
    {
      key: "Mod-Space",
      run(view) {
        return startCompletion(view);
      },
    },
    {
      key: "F12",
      run(view) {
        return requestDefinitionAtPosition(view, callbacksRef, view.state.selection.main.head);
      },
    },
    {
      key: "Mod-f",
      run(view) {
        callbacksRef.current.onFindRequest({
          replace: false,
          seed: findSeedForState(view.state),
        });
        return true;
      },
    },
    {
      key: "Mod-h",
      run(view) {
        callbacksRef.current.onFindRequest({
          replace: true,
          seed: findSeedForState(view.state),
        });
        return true;
      },
    },
    {
      key: "Mod-]",
      run: indentMore,
    },
    {
      key: "Mod-[",
      run: indentLess,
    },
    {
      key: "Mod-Shift-\\",
      run: cursorMatchingBracket,
    },
    {
      key: "Mod-Shift-m",
      run() {
        callbacksRef.current.onToggleProblems();
        return true;
      },
    },
    {
      key: "Mod-Shift-k",
      run: deleteLine,
    },
    {
      key: "Alt-Shift-ArrowDown",
      run: copyLineDown,
    },
    {
      key: "Alt-Shift-ArrowUp",
      run: copyLineUp,
    },
    {
      key: "Mod-Alt-ArrowDown",
      run: addCursorBelow,
    },
    {
      key: "Mod-Alt-ArrowUp",
      run: addCursorAbove,
    },
    {
      key: "Mod-/",
      run: toggleComment,
    },
    {
      key: "Mod-u",
      run: undoSelection,
    },
    {
      key: "Enter",
      run: insertNewlineAndIndent,
    },
    indentWithTab,
    ...completionKeymap,
    ...lintKeymap,
    ...foldKeymap,
    ...historyKeymap,
    ...defaultKeymap,
  ];
}

function createEditorExtensions(input: {
  callbacksRef: MutableRefObject<WorkspaceCodeEditorCallbacks>;
  transientRefs: WorkspaceCodeEditorTransientRefs;
  completionCompartment: Compartment;
  indentUnitCompartment: Compartment;
  languageCompartment: Compartment;
  lineNumbersCompartment: Compartment;
  options: WorkspaceCodeEditorOptions;
  readOnly: boolean;
  readOnlyCompartment: Compartment;
  resolvedTheme: "light" | "dark";
  shikiHighlightCompartment: Compartment;
  tabSizeCompartment: Compartment;
  themeCompartment: Compartment;
  whitespaceCompartment: Compartment;
  wrappingCompartment: Compartment;
  languageId: string | null | undefined;
  activeFilePath: string;
}): Extension[] {
  return [
    input.themeCompartment.of(
      createWorkspaceCodeMirrorTheme({
        options: input.options,
        resolvedTheme: input.resolvedTheme,
      }),
    ),
    input.languageCompartment.of(
      createWorkspaceLanguageExtensions({
        filePath: input.activeFilePath,
        languageId: input.languageId,
      }),
    ),
    input.shikiHighlightCompartment.of(
      createWorkspaceShikiHighlightConfig({
        filePath: input.activeFilePath,
        languageId: input.languageId,
        resolvedTheme: input.resolvedTheme,
      }),
    ),
    input.wrappingCompartment.of(input.options.wordWrap ? EditorView.lineWrapping : []),
    input.readOnlyCompartment.of(setWorkspaceEditorReadOnly(input.readOnly)),
    input.lineNumbersCompartment.of(createWorkspaceLineNumberExtension(input.options.lineNumbers)),
    input.tabSizeCompartment.of(EditorState.tabSize.of(input.options.tabSize)),
    input.indentUnitCompartment.of(indentUnit.of(" ".repeat(input.options.tabSize))),
    input.whitespaceCompartment.of(createWhitespaceExtension(input.options)),
    input.completionCompartment.of(createCompletionExtension(input.callbacksRef, input.options)),
    EditorState.allowMultipleSelections.of(true),
    workspaceShikiHighlightSupport(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    rectangularSelection({
      eventFilter: (event) => event.altKey && event.shiftKey && event.button === 0,
    }),
    EditorView.clickAddsSelectionRange.of(shouldAddWorkspaceSelectionRange),
    highlightSpecialChars(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    highlightSelectionMatches(),
    highlightTrailingWhitespace(),
    indentOnInput(),
    closeBrackets(),
    search({ createPanel: createHiddenSearchPanel }),
    lintGutter(),
    linter(null, { delay: 300, tooltipFilter: suppressCodeMirrorLintTooltip }),
    createWorkspaceDiagnosticHoverExtension(),
    createHoverExtension(input.callbacksRef),
    EditorView.domEventHandlers({
      focus() {
        input.callbacksRef.current.onFocus();
      },
      mousemove(event, view) {
        workspaceDiagnosticHoverMouseByView.set(view, {
          x: event.clientX,
          y: event.clientY,
        });
        return false;
      },
      mousedown(event, view) {
        if (isWorkspaceAddCursorClick(event)) {
          const offset = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (offset === null) {
            return false;
          }
          event.preventDefault();
          event.stopPropagation();
          return addWorkspaceCursorAtPosition(view, offset);
        }
        if (!isWorkspaceDefinitionClick(event)) {
          return false;
        }
        const offset = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (offset === null) {
          return false;
        }
        event.preventDefault();
        event.stopPropagation();
        return requestDefinitionAtPosition(view, input.callbacksRef, offset);
      },
    }),
    EditorView.updateListener.of((update: ViewUpdate) => {
      if (update.docChanged) {
        const contents = update.state.doc.toString();
        input.transientRefs.valueRef.current = contents;
        if (!input.transientRefs.syncingFromPropsRef.current) {
          input.callbacksRef.current.onChange(contents);
        }
        input.callbacksRef.current.onSymbolsChange(contents);
      }
      if (update.docChanged || update.selectionSet || update.focusChanged) {
        input.callbacksRef.current.onCursorLabelChange(cursorLabelForState(update.state));
        input.callbacksRef.current.onSelectionChange(
          selectionForState(update.view, input.callbacksRef.current.activeFilePath),
        );
      }
    }),
    keymap.of(createKeymap(input.callbacksRef)),
  ];
}

function locationToSelection(
  state: EditorState,
  location: WorkspaceEditorLocation,
): {
  readonly from: number;
  readonly to: number;
} {
  const from = workspaceDocOffsetFromPosition({
    column: location.startColumn,
    doc: state.doc,
    line: location.startLine,
  });
  const to = workspaceDocOffsetFromPosition({
    column: location.endColumn,
    doc: state.doc,
    line: location.endLine,
  });
  return { from, to: Math.max(from, to) };
}

const WorkspaceCodeEditor = forwardRef<WorkspaceCodeEditorHandle, WorkspaceCodeEditorProps>(
  function WorkspaceCodeEditor(props, forwardedRef) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    const valueRef = useRef(props.value);
    const syncingFromPropsRef = useRef(false);
    const [completionCompartment] = useState(() => new Compartment());
    const [indentUnitCompartment] = useState(() => new Compartment());
    const [languageCompartment] = useState(() => new Compartment());
    const [lineNumbersCompartment] = useState(() => new Compartment());
    const [readOnlyCompartment] = useState(() => new Compartment());
    const [shikiHighlightCompartment] = useState(() => new Compartment());
    const [tabSizeCompartment] = useState(() => new Compartment());
    const [themeCompartment] = useState(() => new Compartment());
    const [whitespaceCompartment] = useState(() => new Compartment());
    const [wrappingCompartment] = useState(() => new Compartment());
    const callbacksRef = useRef<WorkspaceCodeEditorCallbacks>({
      activeFilePath: props.activeFilePath,
      completionProvider: props.completionProvider,
      languageId: props.languageId,
      onChange: props.onChange,
      onCursorLabelChange: props.onCursorLabelChange,
      onDefinitionRequest: props.onDefinitionRequest,
      onFindRequest: props.onFindRequest,
      onFocus: props.onFocus,
      onHoverRequest: props.onHoverRequest,
      onSave: props.onSave,
      onSelectionChange: props.onSelectionChange,
      onSymbolsChange: props.onSymbolsChange,
      onToggleProblems: props.onToggleProblems,
    });
    updateCallbacksRef(callbacksRef, props);
    const createSnapshotRef = useRef<WorkspaceCodeEditorCreateSnapshot>({
      languageId: props.languageId,
      options: props.options,
      readOnly: props.readOnly ?? false,
      resolvedTheme: props.resolvedTheme,
      value: props.value,
    });
    createSnapshotRef.current = {
      languageId: props.languageId,
      options: props.options,
      readOnly: props.readOnly ?? false,
      resolvedTheme: props.resolvedTheme,
      value: props.value,
    };

    useImperativeHandle(
      forwardedRef,
      () => ({
        closeFindQuery() {
          const view = viewRef.current;
          if (!view) {
            return;
          }
          closeSearchPanel(view);
          view.focus();
        },
        findNext() {
          const view = viewRef.current;
          if (!view) {
            return;
          }
          cmFindNext(view);
          view.focus();
        },
        findPrevious() {
          const view = viewRef.current;
          if (!view) {
            return;
          }
          cmFindPrevious(view);
          view.focus();
        },
        focus() {
          viewRef.current?.focus();
        },
        getFindSeed() {
          const view = viewRef.current;
          if (!view) {
            return "";
          }
          return findSeedForState(view.state);
        },
        replaceAll() {
          const view = viewRef.current;
          if (!view) {
            return;
          }
          cmReplaceAll(view);
          view.focus();
        },
        replaceNext() {
          const view = viewRef.current;
          if (!view) {
            return;
          }
          cmReplaceNext(view);
          view.focus();
        },
        revealLocation(location) {
          const view = viewRef.current;
          if (!view) {
            return;
          }
          const selection = locationToSelection(view.state, location);
          const editorSelection = EditorSelection.create([
            EditorSelection.range(selection.from, selection.to),
          ]);
          view.dispatch({
            effects: EditorView.scrollIntoView(editorSelection.main, { y: "center" }),
            selection: editorSelection,
          });
          view.focus();
        },
        selectFindMatches() {
          const view = viewRef.current;
          if (!view) {
            return;
          }
          cmSelectMatches(view);
          view.focus();
        },
        setPosition(position) {
          const view = viewRef.current;
          if (!view) {
            return;
          }
          const offset = workspaceDocOffsetFromPosition({
            column: position.column,
            doc: view.state.doc,
            line: position.line,
          });
          view.dispatch({
            effects: EditorView.scrollIntoView(offset, { y: "center" }),
            selection: { anchor: offset },
          });
          view.focus();
        },
        triggerCompletion() {
          const view = viewRef.current;
          if (!view) {
            return;
          }
          startCompletion(view);
          view.focus();
        },
        updateFindQuery(state) {
          const view = viewRef.current;
          if (!view) {
            return { capped: false, count: 0 };
          }
          const query = createWorkspaceFindQuery(state);
          if (state.search.length === 0) {
            view.dispatch({ effects: setSearchQuery.of(query) });
            closeSearchPanel(view);
            return { capped: false, count: 0 };
          }
          openSearchPanel(view);
          view.dispatch({ effects: setSearchQuery.of(query) });
          return countWorkspaceFindMatches(view.state, query);
        },
      }),
      [],
    );

    useEffect(() => {
      const parent = hostRef.current;
      if (!parent) {
        return;
      }
      const createSnapshot = createSnapshotRef.current;
      valueRef.current = createSnapshot.value;

      const view = new EditorView({
        doc: createSnapshot.value,
        extensions: createEditorExtensions({
          activeFilePath: props.activeFilePath,
          callbacksRef,
          completionCompartment,
          indentUnitCompartment,
          languageCompartment,
          languageId: createSnapshot.languageId,
          lineNumbersCompartment,
          options: createSnapshot.options,
          readOnly: createSnapshot.readOnly,
          readOnlyCompartment,
          resolvedTheme: createSnapshot.resolvedTheme,
          shikiHighlightCompartment,
          tabSizeCompartment,
          themeCompartment,
          transientRefs: { syncingFromPropsRef, valueRef },
          whitespaceCompartment,
          wrappingCompartment,
        }),
        parent,
      });
      viewRef.current = view;
      callbacksRef.current.onCursorLabelChange(cursorLabelForState(view.state));
      callbacksRef.current.onSymbolsChange(view.state.doc.toString());
      forceLinting(view);

      return () => {
        view.destroy();
        if (viewRef.current === view) {
          viewRef.current = null;
        }
      };
    }, [
      callbacksRef,
      completionCompartment,
      indentUnitCompartment,
      languageCompartment,
      props.activeFilePath,
      lineNumbersCompartment,
      readOnlyCompartment,
      shikiHighlightCompartment,
      tabSizeCompartment,
      themeCompartment,
      whitespaceCompartment,
      wrappingCompartment,
    ]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view || props.value === valueRef.current) {
        return;
      }
      valueRef.current = props.value;
      syncingFromPropsRef.current = true;
      view.dispatch({
        changes: { from: 0, insert: props.value, to: view.state.doc.length },
      });
      syncingFromPropsRef.current = false;
    }, [props.value]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) {
        return;
      }
      const nextDiagnostics = toCodeMirrorDiagnostics(view.state, props.diagnostics);
      view.dispatch(setDiagnostics(view.state, nextDiagnostics));
    }, [props.diagnostics]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) {
        return;
      }
      view.dispatch({
        effects: [
          themeCompartment.reconfigure(
            createWorkspaceCodeMirrorTheme({
              options: props.options,
              resolvedTheme: props.resolvedTheme,
            }),
          ),
          languageCompartment.reconfigure(
            createWorkspaceLanguageExtensions({
              filePath: props.activeFilePath,
              languageId: props.languageId,
            }),
          ),
          shikiHighlightCompartment.reconfigure(
            createWorkspaceShikiHighlightConfig({
              filePath: props.activeFilePath,
              languageId: props.languageId,
              resolvedTheme: props.resolvedTheme,
            }),
          ),
          wrappingCompartment.reconfigure(props.options.wordWrap ? EditorView.lineWrapping : []),
          readOnlyCompartment.reconfigure(setWorkspaceEditorReadOnly(props.readOnly ?? false)),
          lineNumbersCompartment.reconfigure(
            createWorkspaceLineNumberExtension(props.options.lineNumbers),
          ),
          tabSizeCompartment.reconfigure(EditorState.tabSize.of(props.options.tabSize)),
          indentUnitCompartment.reconfigure(indentUnit.of(" ".repeat(props.options.tabSize))),
          whitespaceCompartment.reconfigure(createWhitespaceExtension(props.options)),
          completionCompartment.reconfigure(createCompletionExtension(callbacksRef, props.options)),
        ],
      });
    }, [
      callbacksRef,
      completionCompartment,
      indentUnitCompartment,
      languageCompartment,
      lineNumbersCompartment,
      props.activeFilePath,
      props.languageId,
      props.options,
      props.readOnly,
      props.resolvedTheme,
      readOnlyCompartment,
      shikiHighlightCompartment,
      tabSizeCompartment,
      themeCompartment,
      whitespaceCompartment,
      wrappingCompartment,
    ]);

    return (
      <div
        ref={hostRef}
        className={cn("h-full min-h-0 w-full min-w-0 overflow-hidden", props.className)}
        data-workspace-code-editor="true"
      />
    );
  },
);

WorkspaceCodeEditor.displayName = "WorkspaceCodeEditor";

export default WorkspaceCodeEditor;
