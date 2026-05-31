import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { MergeView } from "@codemirror/merge";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, highlightSpecialChars, keymap } from "@codemirror/view";
import { memo, useEffect, useRef } from "react";

import {
  createWorkspaceCodeMirrorTheme,
  createWorkspaceLineNumberExtension,
  setWorkspaceEditorReadOnly,
} from "~/lib/editor/workspaceCodeMirror";
import type { WorkspaceCodeEditorOptions } from "~/lib/editor/workspaceEditorOptions";
import { cn } from "~/lib/utils";

interface WorkspaceDiffEditorProps {
  readonly className?: string;
  readonly height: number;
  readonly modified: string;
  readonly options: WorkspaceCodeEditorOptions;
  readonly original: string;
  readonly resolvedTheme: "light" | "dark";
}

function createDiffEditorExtensions(input: {
  readonly options: WorkspaceCodeEditorOptions;
  readonly resolvedTheme: "light" | "dark";
}): Extension[] {
  return [
    createWorkspaceCodeMirrorTheme(input),
    ...setWorkspaceEditorReadOnly(true),
    ...createWorkspaceLineNumberExtension(input.options.lineNumbers),
    EditorState.tabSize.of(input.options.tabSize),
    history(),
    highlightSpecialChars(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    keymap.of([...historyKeymap, ...defaultKeymap]),
    EditorView.theme({
      ".cm-editor": {
        height: "100%",
      },
      ".cm-mergeView": {
        height: "100%",
        overflow: "auto",
      },
      ".cm-mergeViewEditors": {
        height: "100%",
      },
      ".cm-scroller": {
        overflow: "auto",
      },
    }),
  ];
}

function WorkspaceDiffEditor(props: WorkspaceDiffEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const parent = hostRef.current;
    if (!parent) {
      return;
    }
    parent.textContent = "";
    const extensions = createDiffEditorExtensions({
      options: props.options,
      resolvedTheme: props.resolvedTheme,
    });
    const mergeView = new MergeView({
      a: {
        doc: props.original,
        extensions,
      },
      b: {
        doc: props.modified,
        extensions,
      },
      collapseUnchanged: { margin: 3, minSize: 8 },
      diffConfig: { scanLimit: 4_000, timeout: 120 },
      gutter: true,
      highlightChanges: true,
      parent,
    });
    mergeView.dom.style.height = "100%";
    mergeView.dom.style.overflow = "auto";

    return () => {
      mergeView.destroy();
    };
  }, [props.modified, props.options, props.original, props.resolvedTheme]);

  return (
    <div
      ref={hostRef}
      className={cn("min-w-0 overflow-hidden rounded-md border border-border", props.className)}
      style={{ height: props.height }}
    />
  );
}

export default memo(WorkspaceDiffEditor);
