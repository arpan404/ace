import type { EditorLineNumbers, WorkspaceEditorDiagnostic } from "@ace/contracts";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { bracketMatching, type LanguageSupport } from "@codemirror/language";
import { EditorState, type Extension, type Text } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";

import type { WorkspaceCodeEditorOptions } from "./workspaceEditorOptions";

export const WORKSPACE_CODE_EDITOR_PROBLEM_OWNER = "ace-workspace-editor";

export const WORKSPACE_CODE_EDITOR_SEVERITY = {
  error: 8,
  hint: 1,
  info: 2,
  warning: 4,
} as const satisfies Record<WorkspaceEditorDiagnostic["severity"], number>;

export type WorkspaceCodeEditorSeverityValue =
  (typeof WORKSPACE_CODE_EDITOR_SEVERITY)[keyof typeof WORKSPACE_CODE_EDITOR_SEVERITY];

export interface WorkspaceCodeEditorProblem {
  readonly code?: string | number;
  readonly endColumn: number;
  readonly endLineNumber: number;
  readonly message: string;
  readonly owner: string;
  readonly severity: number;
  readonly source?: string;
  readonly startColumn: number;
  readonly startLineNumber: number;
}

export function workspaceSeverityFromValue(
  severity: number,
): WorkspaceEditorDiagnostic["severity"] {
  if (severity >= WORKSPACE_CODE_EDITOR_SEVERITY.error) {
    return "error";
  }
  if (severity >= WORKSPACE_CODE_EDITOR_SEVERITY.warning) {
    return "warning";
  }
  if (severity >= WORKSPACE_CODE_EDITOR_SEVERITY.info) {
    return "info";
  }
  return "hint";
}

export function workspaceSeverityValue(
  severity: WorkspaceEditorDiagnostic["severity"],
): WorkspaceCodeEditorSeverityValue {
  return WORKSPACE_CODE_EDITOR_SEVERITY[severity];
}

export function createWorkspaceCodeMirrorTheme(input: {
  options: WorkspaceCodeEditorOptions;
  resolvedTheme: "light" | "dark";
}): Extension {
  const dark = input.resolvedTheme === "dark";
  return EditorView.theme(
    {
      "&": {
        backgroundColor: "var(--background)",
        color: "var(--foreground)",
        fontSize: `${input.options.fontSize}px`,
        height: "100%",
      },
      ".cm-activeLine": {
        backgroundColor: dark ? "rgba(255,255,255,0.035)" : "rgba(15,23,42,0.035)",
      },
      ".cm-activeLineGutter": {
        backgroundColor: dark ? "rgba(255,255,255,0.05)" : "rgba(15,23,42,0.06)",
        color: "var(--foreground)",
      },
      ".cm-content": {
        caretColor: "var(--foreground)",
        minHeight: "100%",
        padding: "0",
      },
      ".cm-cursor": {
        borderLeftColor: "var(--foreground)",
        borderLeftWidth: "1.5px",
      },
      ".cm-diagnostic": {
        borderRadius: "6px",
        fontFamily: "var(--font-sans, system-ui, sans-serif)",
        fontSize: "12px",
      },
      ".cm-diagnostic-error": {
        borderLeftColor: "var(--destructive)",
      },
      ".cm-foldGutter span": {
        cursor: "pointer",
      },
      ".cm-gutters": {
        backgroundColor: "var(--card)",
        borderRight: "1px solid var(--border)",
        color: "var(--muted-foreground)",
      },
      ".cm-highlightSpace:after": {
        color: "var(--muted-foreground)",
        opacity: "0.32",
      },
      ".cm-highlightTab": {
        backgroundImage:
          "linear-gradient(to right, transparent 45%, color-mix(in srgb, var(--muted-foreground) 35%, transparent) 45%, color-mix(in srgb, var(--muted-foreground) 35%, transparent) 55%, transparent 55%)",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
        backgroundSize: "0.5em 1px",
      },
      ".cm-line": {
        padding: "0 12px",
      },
      ".cm-lineNumbers .cm-gutterElement": {
        minWidth: "3.5ch",
        padding: "0 8px 0 10px",
      },
      ".cm-matchingBracket, .cm-nonmatchingBracket": {
        outline: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)",
      },
      ".cm-panels": {
        backgroundColor: "var(--card)",
        borderColor: "var(--border)",
        color: "var(--foreground)",
      },
      ".cm-panels input": {
        backgroundColor: "var(--background)",
        border: "1px solid var(--border)",
        borderRadius: "6px",
        color: "var(--foreground)",
        outline: "none",
      },
      ".cm-scroller": {
        fontFamily: input.options.fontFamily,
        lineHeight: `${input.options.lineHeight}px`,
        overflow: "auto",
      },
      ".cm-searchMatch": {
        backgroundColor: dark ? "rgba(245,158,11,0.28)" : "rgba(245,158,11,0.22)",
      },
      ".cm-searchMatch-selected": {
        backgroundColor: dark ? "rgba(14,165,233,0.38)" : "rgba(14,165,233,0.28)",
      },
      ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
        backgroundColor: dark ? "rgba(56,189,248,0.28)" : "rgba(14,116,144,0.2)",
      },
      ".cm-tooltip": {
        backgroundColor: "var(--popover)",
        border: "1px solid var(--border)",
        borderRadius: "8px",
        color: "var(--popover-foreground)",
        overflow: "hidden",
        boxShadow: dark ? "0 18px 44px rgba(0,0,0,0.42)" : "0 18px 44px rgba(15,23,42,0.16)",
      },
      ".cm-tooltip-autocomplete > ul": {
        fontFamily: "var(--font-sans, system-ui, sans-serif)",
        maxHeight: "min(360px, 48vh)",
      },
      ".cm-tooltip-autocomplete li[aria-selected]": {
        backgroundColor: "var(--accent)",
        color: "var(--accent-foreground)",
      },
      ".cm-trailingSpace": {
        backgroundColor: dark ? "rgba(248,113,113,0.18)" : "rgba(239,68,68,0.12)",
      },
    },
    { dark },
  );
}

export function createWorkspaceLineNumberExtension(mode: EditorLineNumbers): Extension[] {
  if (mode === "off") {
    return [];
  }
  if (mode === "relative") {
    return [
      lineNumbers({
        formatNumber(lineNo, state) {
          const activeLine = state.doc.lineAt(state.selection.main.head).number;
          return lineNo === activeLine ? String(lineNo) : String(Math.abs(lineNo - activeLine));
        },
      }),
    ];
  }
  return [lineNumbers()];
}

export function createWorkspaceLanguageExtensions(input: {
  filePath: string | null;
  languageId: string | null | undefined;
}): Extension[] {
  const language = resolveWorkspaceLanguageSupport(input);
  return language ? [language, bracketMatching()] : [bracketMatching()];
}

function resolveWorkspaceLanguageSupport(input: {
  filePath: string | null;
  languageId: string | null | undefined;
}): LanguageSupport | null {
  const filePath = input.filePath?.toLowerCase() ?? "";
  switch (input.languageId) {
    case "typescript":
      return javascript({ jsx: filePath.endsWith(".tsx"), typescript: true });
    case "javascript":
      return javascript({ jsx: filePath.endsWith(".jsx") });
    case "json":
      return json();
    case "css":
    case "scss":
    case "less":
      return css();
    case "html":
      return html();
    case "markdown":
    case "mdx":
      return markdown();
    case "yaml":
      return yaml();
    case "xml":
      return xml();
    case "python":
      return python();
    case "rust":
      return rust();
    case "sql":
      return sql();
    default:
      return null;
  }
}

export function workspaceDocOffsetFromPosition(input: {
  column: number;
  doc: Text;
  line: number;
}): number {
  const lineNumber = Math.max(1, Math.min(input.doc.lines, input.line + 1));
  const line = input.doc.line(lineNumber);
  return Math.max(line.from, Math.min(line.to, line.from + input.column));
}

export function workspacePositionFromOffset(input: { doc: Text; offset: number }): {
  readonly column: number;
  readonly line: number;
} {
  const line = input.doc.lineAt(input.offset);
  return {
    column: Math.max(0, input.offset - line.from),
    line: Math.max(0, line.number - 1),
  };
}

export function setWorkspaceEditorReadOnly(readOnly: boolean): Extension[] {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}
