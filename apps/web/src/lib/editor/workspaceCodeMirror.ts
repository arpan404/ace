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

function workspaceLintUnderline(color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="6" height="3" viewBox="0 0 6 3"><path d="M0 .9 1.5 2.1 3 .9 4.5 2.1 6 .9" fill="none" stroke="${color}" stroke-width=".8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

export function createWorkspaceCodeMirrorTheme(input: {
  options: WorkspaceCodeEditorOptions;
  resolvedTheme: "light" | "dark";
}): Extension {
  const dark = input.resolvedTheme === "dark";
  const diagnosticError = dark ? "#f14c4c" : "#d1242f";
  const diagnosticWarning = dark ? "#cca700" : "#9a6700";
  const diagnosticInfo = dark ? "#3794ff" : "#0969da";
  const diagnosticHint = dark ? "#a6a6a6" : "#57606a";
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
        borderLeft: "0",
        borderRadius: "0",
        boxSizing: "border-box",
        display: "block",
        fontFamily: "var(--font-sans, system-ui, sans-serif)",
        fontSize: "12.5px",
        lineHeight: "1.45",
        marginLeft: "0",
        minWidth: "260px",
        padding: "8px 12px 8px 10px",
        whiteSpace: "normal",
      },
      ".cm-diagnostic + .cm-diagnostic": {
        borderTop: "1px solid color-mix(in srgb, var(--border) 68%, transparent)",
      },
      ".cm-diagnosticText": {
        alignItems: "start",
        display: "grid",
        gap: "0 8px",
        gridTemplateColumns: "8px minmax(0, 1fr)",
      },
      ".cm-diagnosticText:before": {
        borderRadius: "999px",
        content: '""',
        height: "8px",
        marginTop: "5px",
        width: "8px",
      },
      ".cm-diagnostic-error .cm-diagnosticText:before": {
        backgroundColor: diagnosticError,
      },
      ".cm-diagnostic-warning .cm-diagnosticText:before": {
        backgroundColor: diagnosticWarning,
      },
      ".cm-diagnostic-info .cm-diagnosticText:before": {
        backgroundColor: diagnosticInfo,
      },
      ".cm-diagnostic-hint .cm-diagnosticText:before": {
        backgroundColor: diagnosticHint,
      },
      ".ace-workspace-diagnostic-message": {
        display: "grid",
        gap: "4px",
        minWidth: "0",
      },
      ".ace-workspace-diagnostic-message-text": {
        color: "var(--popover-foreground)",
        fontWeight: "500",
        minWidth: "0",
        overflowWrap: "anywhere",
      },
      ".ace-workspace-diagnostic-message-code": {
        color: "var(--muted-foreground)",
        fontFamily: "var(--font-mono, ui-monospace, monospace)",
        fontSize: "11px",
      },
      ".cm-diagnosticAction": {
        backgroundColor: dark ? "rgba(255,255,255,0.085)" : "rgba(15,23,42,0.075)",
        border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
        borderRadius: "4px",
        color: "var(--popover-foreground)",
        cursor: "pointer",
        font: "inherit",
        fontSize: "11px",
        fontWeight: "500",
        margin: "7px 0 0 16px",
        padding: "3px 7px",
      },
      ".cm-diagnosticAction:hover": {
        backgroundColor: "var(--accent)",
        color: "var(--accent-foreground)",
      },
      ".cm-diagnosticSource": {
        color: "var(--muted-foreground)",
        fontFamily: "var(--font-sans, system-ui, sans-serif)",
        fontSize: "11px",
        margin: "4px 0 0 16px",
        opacity: "0.86",
      },
      ".cm-foldGutter span": {
        cursor: "pointer",
      },
      ".cm-gutter-lint": {
        width: "18px",
      },
      ".cm-gutter-lint .cm-gutterElement": {
        alignItems: "center",
        display: "flex",
        justifyContent: "center",
        padding: "0",
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
      ".cm-panels:has(.ace-workspace-hidden-search-panel)": {
        display: "none",
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
      ".cm-tooltip > .cm-tooltip-lint": {
        listStyle: "none",
        margin: "0",
        maxWidth: "min(520px, calc(100vw - 48px))",
        padding: "0",
      },
      ".cm-lintRange": {
        backgroundPosition: "left calc(100% - 1px)",
        backgroundRepeat: "repeat-x",
        backgroundSize: "6px 3px",
        paddingBottom: "2px",
        textDecoration: "none",
      },
      ".cm-lintRange-error": {
        backgroundImage: workspaceLintUnderline(diagnosticError),
      },
      ".cm-lintRange-warning": {
        backgroundImage: workspaceLintUnderline(diagnosticWarning),
      },
      ".cm-lintRange-info": {
        backgroundImage: workspaceLintUnderline(diagnosticInfo),
      },
      ".cm-lintRange-hint": {
        backgroundImage: workspaceLintUnderline(diagnosticHint),
      },
      ".cm-lintRange-active": {
        backgroundColor: dark ? "rgba(255,255,255,0.055)" : "rgba(15,23,42,0.045)",
      },
      ".cm-lintRange-error.cm-lintRange-active": {
        backgroundColor: dark ? "rgba(241,76,76,0.12)" : "rgba(209,36,47,0.08)",
      },
      ".cm-lintRange-warning.cm-lintRange-active": {
        backgroundColor: dark ? "rgba(204,167,0,0.13)" : "rgba(154,103,0,0.08)",
      },
      ".cm-lintRange-info.cm-lintRange-active": {
        backgroundColor: dark ? "rgba(55,148,255,0.12)" : "rgba(9,105,218,0.08)",
      },
      ".cm-lintPoint": {
        position: "relative",
      },
      ".cm-lintPoint:after": {
        borderBottom: `5px solid ${diagnosticError}`,
        borderLeft: "4px solid transparent",
        borderRight: "4px solid transparent",
        bottom: "-1px",
        content: '""',
        left: "-3px",
        position: "absolute",
      },
      ".cm-lintPoint-warning:after": {
        borderBottomColor: diagnosticWarning,
      },
      ".cm-lintPoint-info:after": {
        borderBottomColor: diagnosticInfo,
      },
      ".cm-lintPoint-hint:after": {
        borderBottomColor: diagnosticHint,
      },
      ".cm-lint-marker": {
        borderRadius: "999px",
        boxSizing: "border-box",
        content: '""',
        height: "9px",
        margin: "0 auto",
        width: "9px",
      },
      ".cm-lint-marker-error": {
        backgroundColor: diagnosticError,
        border: `1px solid ${dark ? "#ff9b95" : "#b4232c"}`,
        boxShadow: dark ? "0 0 0 2px rgba(241,76,76,0.20)" : "0 0 0 2px rgba(209,36,47,0.14)",
        content: '""',
      },
      ".cm-lint-marker-warning": {
        backgroundColor: diagnosticWarning,
        border: `1px solid ${dark ? "#ffe08a" : "#8a5700"}`,
        boxShadow: dark ? "0 0 0 2px rgba(204,167,0,0.18)" : "0 0 0 2px rgba(154,103,0,0.13)",
        content: '""',
      },
      ".cm-lint-marker-info": {
        backgroundColor: diagnosticInfo,
        border: `1px solid ${dark ? "#9dccff" : "#085fbe"}`,
        boxShadow: dark ? "0 0 0 2px rgba(55,148,255,0.18)" : "0 0 0 2px rgba(9,105,218,0.13)",
        content: '""',
      },
      ".cm-lint-marker-hint": {
        backgroundColor: diagnosticHint,
        border: `1px solid ${dark ? "#d4d4d4" : "#424a53"}`,
        boxShadow: dark ? "0 0 0 2px rgba(166,166,166,0.14)" : "0 0 0 2px rgba(87,96,106,0.11)",
        content: '""',
      },
      ".cm-panel.cm-panel-lint": {
        backgroundColor: "var(--card)",
        borderColor: "var(--border)",
        color: "var(--foreground)",
      },
      ".cm-panel.cm-panel-lint ul": {
        fontFamily: "var(--font-sans, system-ui, sans-serif)",
        maxHeight: "180px",
      },
      ".cm-panel.cm-panel-lint ul [aria-selected]": {
        backgroundColor: "var(--accent)",
        color: "var(--accent-foreground)",
      },
      ".cm-tooltip.cm-tooltip-autocomplete": {
        minWidth: "320px",
        padding: "3px 0",
      },
      ".cm-tooltip-autocomplete > ul": {
        fontFamily: input.options.fontFamily,
        maxHeight: "min(360px, 48vh)",
        minWidth: "320px",
        padding: "3px 0",
      },
      ".cm-tooltip-autocomplete > ul > li": {
        alignItems: "center",
        borderLeft: "2px solid transparent",
        boxSizing: "border-box",
        cursor: "pointer",
        display: "flex",
        minHeight: "24px",
        overflow: "hidden",
        padding: "2px 10px 2px 7px",
      },
      ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
        backgroundColor: dark ? "rgba(4,57,94,0.92)" : "rgba(9,105,218,0.12)",
        borderLeftColor: diagnosticInfo,
        color: "var(--foreground)",
      },
      ".cm-completionIcon": {
        boxSizing: "content-box",
        color: "var(--muted-foreground)",
        display: "inline-flex",
        fontSize: "12px",
        justifyContent: "center",
        opacity: "0.9",
        paddingRight: "8px",
        width: "16px",
      },
      ".cm-completionIcon-function, .cm-completionIcon-method": {
        color: "#b180d7",
      },
      ".cm-completionIcon-class, .cm-completionIcon-interface, .cm-completionIcon-type": {
        color: "#4ec9b0",
      },
      ".cm-completionIcon-variable, .cm-completionIcon-constant": {
        color: "#9cdcfe",
      },
      ".cm-completionIcon-property, .cm-completionIcon-field": {
        color: "#dcdcaa",
      },
      ".cm-completionIcon-keyword": {
        color: "#569cd6",
      },
      ".cm-completionLabel": {
        minWidth: "0",
        overflow: "hidden",
        textOverflow: "ellipsis",
      },
      ".cm-completionMatchedText": {
        color: dark ? "#9cdcfe" : "#0969da",
        fontWeight: "700",
        textDecoration: "none",
      },
      ".cm-completionDetail": {
        color: "var(--muted-foreground)",
        fontFamily: "var(--font-sans, system-ui, sans-serif)",
        fontSize: "11px",
        fontStyle: "normal",
        marginLeft: "auto",
        maxWidth: "48%",
        overflow: "hidden",
        paddingLeft: "14px",
        textOverflow: "ellipsis",
      },
      ".cm-tooltip.cm-completionInfo": {
        fontFamily: "var(--font-sans, system-ui, sans-serif)",
        fontSize: "12px",
        lineHeight: "1.55",
        maxWidth: "min(420px, calc(100vw - 48px))",
        padding: "9px 10px",
      },
      ".ace-workspace-hover-tooltip": {
        display: "grid",
        fontFamily: "var(--font-sans, system-ui, sans-serif)",
        gap: "8px",
        maxWidth: "min(560px, calc(100vw - 48px))",
        padding: "10px",
      },
      ".ace-workspace-hover-section": {
        display: "grid",
        gap: "7px",
        minWidth: "0",
      },
      ".ace-workspace-hover-section + .ace-workspace-hover-section": {
        borderTop: "1px solid color-mix(in srgb, var(--border) 72%, transparent)",
        paddingTop: "8px",
      },
      ".ace-workspace-hover-text": {
        color: "var(--popover-foreground)",
        fontSize: "12px",
        lineHeight: "1.55",
        whiteSpace: "pre-wrap",
      },
      ".ace-workspace-hover-code": {
        border: "1px solid color-mix(in srgb, var(--border) 72%, transparent)",
        borderRadius: "7px",
        overflow: "hidden",
      },
      ".ace-workspace-hover-code-language": {
        backgroundColor: "color-mix(in srgb, var(--muted) 52%, transparent)",
        borderBottom: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
        color: "var(--muted-foreground)",
        fontFamily: "var(--font-sans, system-ui, sans-serif)",
        fontSize: "10px",
        fontWeight: "600",
        padding: "4px 7px",
      },
      ".ace-workspace-hover-code pre": {
        backgroundColor: dark ? "rgba(255,255,255,0.035)" : "rgba(15,23,42,0.035)",
        color: "var(--popover-foreground)",
        fontFamily: input.options.fontFamily,
        fontSize: "12px",
        lineHeight: "1.5",
        margin: "0",
        maxHeight: "240px",
        overflow: "auto",
        padding: "7px",
        whiteSpace: "pre",
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
