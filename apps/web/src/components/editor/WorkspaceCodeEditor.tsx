import type {
  WorkspaceEditorCompletionItem,
  WorkspaceEditorDiagnostic,
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
import {
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  forceLinting,
  lintGutter,
  lintKeymap,
  linter,
  setDiagnostics,
  type Diagnostic as CodeMirrorDiagnostic,
} from "@codemirror/lint";
import { highlightSelectionMatches, openSearchPanel, searchKeymap } from "@codemirror/search";
import { Compartment, EditorSelection, EditorState, type Extension } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  highlightTrailingWhitespace,
  highlightWhitespace,
  keymap,
  rectangularSelection,
  scrollPastEnd,
  type KeyBinding,
  type ViewUpdate,
} from "@codemirror/view";
import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
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
import { cn } from "~/lib/utils";

const COMPLETION_TRIGGER_CHARACTERS = new Set([".", "/", '"', "'", ":", "<", "@"]);
const COMPLETION_WORD_PATTERN = /[\w$.-]*$/u;
const COMPLETION_VALID_FOR_PATTERN = /^[\w$.-]*$/u;

export interface WorkspaceCodeEditorHandle {
  readonly focus: () => void;
  readonly openFindPanel: () => void;
  readonly revealLocation: (location: WorkspaceEditorLocation) => void;
  readonly setPosition: (position: { readonly column: number; readonly line: number }) => void;
  readonly triggerCompletion: () => void;
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
  readonly onFocus: () => void;
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
  readonly onFocus: WorkspaceCodeEditorProps["onFocus"];
  readonly onSave: WorkspaceCodeEditorProps["onSave"];
  readonly onSelectionChange: WorkspaceCodeEditorProps["onSelectionChange"];
  readonly onSymbolsChange: WorkspaceCodeEditorProps["onSymbolsChange"];
  readonly onToggleProblems: WorkspaceCodeEditorProps["onToggleProblems"];
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
    onFocus: props.onFocus,
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
    if (
      !callbacks.completionProvider ||
      !callbacks.languageId ||
      !shouldRequestCompletion(context)
    ) {
      return null;
    }

    const word = context.matchBefore(COMPLETION_WORD_PATTERN);
    const line = context.state.doc.lineAt(context.pos);
    try {
      const items = await callbacks.completionProvider({
        column: Math.max(0, context.pos - line.from),
        contents: context.state.doc.toString(),
        line: Math.max(0, line.number - 1),
      });
      if (context.aborted) {
        return null;
      }
      return {
        from: word?.from ?? context.pos,
        options: items.map(toCodeMirrorCompletion),
        validFor: COMPLETION_VALID_FOR_PATTERN,
      };
    } catch {
      return null;
    }
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
      severity: diagnostic.severity,
      to: Math.min(to, state.doc.length),
    };
    if (diagnostic.source) {
      result.source = diagnostic.source;
    }
    return result;
  });
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
  const line = view.state.doc.lineAt(offset);
  callbacksRef.current.onDefinitionRequest({
    column: Math.max(0, offset - line.from),
    contents: view.state.doc.toString(),
    line: Math.max(0, line.number - 1),
  });
  return true;
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
        openSearchPanel(view);
        return true;
      },
    },
    {
      key: "Mod-h",
      run(view) {
        openSearchPanel(view);
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
    ...searchKeymap,
    ...lintKeymap,
    ...foldKeymap,
    ...historyKeymap,
    ...defaultKeymap,
  ];
}

function createEditorExtensions(input: {
  callbacksRef: MutableRefObject<WorkspaceCodeEditorCallbacks>;
  transientRefs: WorkspaceCodeEditorTransientRefs;
  languageCompartment: Compartment;
  options: WorkspaceCodeEditorOptions;
  readOnly: boolean;
  resolvedTheme: "light" | "dark";
  themeCompartment: Compartment;
  wrappingCompartment: Compartment;
  languageId: string | null | undefined;
  activeFilePath: string;
}): Extension[] {
  const completionSource = createCompletionSource(input.callbacksRef);
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
    input.wrappingCompartment.of(input.options.wordWrap ? EditorView.lineWrapping : []),
    ...setWorkspaceEditorReadOnly(input.readOnly),
    ...createWorkspaceLineNumberExtension(input.options.lineNumbers),
    EditorState.tabSize.of(input.options.tabSize),
    indentUnit.of(" ".repeat(input.options.tabSize)),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    crosshairCursor(),
    highlightSpecialChars(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    highlightSelectionMatches(),
    highlightTrailingWhitespace(),
    scrollPastEnd(),
    indentOnInput(),
    closeBrackets(),
    lintGutter(),
    linter(null, { delay: 300 }),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    input.options.renderWhitespace ? highlightWhitespace() : [],
    input.options.suggestions
      ? autocompletion({
          activateOnTyping: true,
          defaultKeymap: false,
          override: [completionSource],
        })
      : [],
    EditorView.domEventHandlers({
      focus() {
        input.callbacksRef.current.onFocus();
      },
      mousedown(event, view) {
        if (!(event.metaKey || event.ctrlKey) || event.button !== 0) {
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

const WorkspaceCodeEditor = memo(
  forwardRef<WorkspaceCodeEditorHandle, WorkspaceCodeEditorProps>(
    function WorkspaceCodeEditor(props, forwardedRef) {
      const hostRef = useRef<HTMLDivElement | null>(null);
      const viewRef = useRef<EditorView | null>(null);
      const valueRef = useRef(props.value);
      const syncingFromPropsRef = useRef(false);
      const languageCompartment = useMemo(() => new Compartment(), []);
      const themeCompartment = useMemo(() => new Compartment(), []);
      const wrappingCompartment = useMemo(() => new Compartment(), []);
      const callbacksRef = useRef<WorkspaceCodeEditorCallbacks>({
        activeFilePath: props.activeFilePath,
        completionProvider: props.completionProvider,
        languageId: props.languageId,
        onChange: props.onChange,
        onCursorLabelChange: props.onCursorLabelChange,
        onDefinitionRequest: props.onDefinitionRequest,
        onFocus: props.onFocus,
        onSave: props.onSave,
        onSelectionChange: props.onSelectionChange,
        onSymbolsChange: props.onSymbolsChange,
        onToggleProblems: props.onToggleProblems,
      });
      updateCallbacksRef(callbacksRef, props);

      useImperativeHandle(
        forwardedRef,
        () => ({
          focus() {
            viewRef.current?.focus();
          },
          openFindPanel() {
            const view = viewRef.current;
            if (!view) {
              return;
            }
            openSearchPanel(view);
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
        }),
        [],
      );

      useEffect(() => {
        const parent = hostRef.current;
        if (!parent) {
          return;
        }
        valueRef.current = props.value;

        const view = new EditorView({
          doc: props.value,
          extensions: createEditorExtensions({
            activeFilePath: props.activeFilePath,
            callbacksRef,
            languageCompartment,
            languageId: props.languageId,
            options: props.options,
            readOnly: props.readOnly ?? false,
            resolvedTheme: props.resolvedTheme,
            themeCompartment,
            transientRefs: { syncingFromPropsRef, valueRef },
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
        languageCompartment,
        props.activeFilePath,
        props.languageId,
        props.options,
        props.readOnly,
        props.resolvedTheme,
        themeCompartment,
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
            wrappingCompartment.reconfigure(props.options.wordWrap ? EditorView.lineWrapping : []),
          ],
        });
      }, [
        languageCompartment,
        props.activeFilePath,
        props.languageId,
        props.options,
        props.resolvedTheme,
        themeCompartment,
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
  ),
);

WorkspaceCodeEditor.displayName = "WorkspaceCodeEditor";

export default WorkspaceCodeEditor;
