import type { Indent, Selection } from "@ace/editor";

/*
 * What a status line says about one editor, as data: the caret, the selection, the indentation,
 * the line ending, the encoding and the language, plus the setters that change the last ones.
 * The editor's own status line renders it; a workbench that draws one status line for the
 * focused editor reads the same thing through `onStatus` or the handle.
 */

/** One editor's status, ready to show. Lines and columns are 1-based, as people read them. */
export interface EditorStatus {
  /** The primary caret's line, 1-based. */
  line: number;
  /** The primary caret's UTF-16 column, 1-based. */
  column: number;
  /** How many cursors there are. */
  selections: number;
  /** With one selection on one line, how many characters it covers; else 0. */
  selectedCharacters: number;
  /** With one selection over several lines, how many lines it touches; else 0. */
  selectedLines: number;
  indent: Indent;
  lineEnding: "\n" | "\r\n";
  /** Files open as UTF-8; there is no other encoding today. */
  encoding: "UTF-8";
  /** The highlighting language in use, undefined for plain text. */
  language: string | undefined;
  /** Whether a language was picked over the file's own. */
  languageChosen: boolean;
  /** Whether whitespace marks are drawn. */
  whitespace: boolean;
  readOnly: boolean;
}

/** The status line's setters. Each applies to the editor it came from. */
export interface EditorStatusActions {
  setIndent(indent: Indent): void;
  /** Rewrites every line break as one undoable edit; ignored while read-only. */
  setLineEnding(ending: "\n" | "\r\n"): void;
  /** A language to highlight and comment with; undefined is plain text, `"file"` the file's own. */
  setLanguage(language: string | undefined | "file"): void;
  setWhitespace(show: boolean): void;
}

/** The status for a set of cursors and the document's settings. */
export function editorStatus(input: {
  selections: readonly Selection[];
  primary: number;
  indent: Indent;
  lineEnding: "\n" | "\r\n";
  language: string | undefined;
  languageChosen: boolean;
  whitespace: boolean;
  readOnly: boolean;
}): EditorStatus {
  const current = input.selections[input.primary] ?? input.selections[0];
  const head = current?.head ?? { line: 0, column: 0 };
  const anchor = current?.anchor ?? head;
  const one = input.selections.length <= 1;
  return {
    line: head.line + 1,
    column: head.column + 1,
    selections: Math.max(1, input.selections.length),
    selectedCharacters:
      one && anchor.line === head.line ? Math.abs(head.column - anchor.column) : 0,
    selectedLines: one && anchor.line !== head.line ? Math.abs(head.line - anchor.line) + 1 : 0,
    indent: input.indent,
    lineEnding: input.lineEnding,
    encoding: "UTF-8",
    language: input.language,
    languageChosen: input.languageChosen,
    whitespace: input.whitespace,
    readOnly: input.readOnly,
  };
}

/** Whether two statuses would read the same, so a listener hears only real changes. */
export function sameStatus(a: EditorStatus, b: EditorStatus): boolean {
  return (
    a.line === b.line &&
    a.column === b.column &&
    a.selections === b.selections &&
    a.selectedCharacters === b.selectedCharacters &&
    a.selectedLines === b.selectedLines &&
    a.indent.tabs === b.indent.tabs &&
    a.indent.size === b.indent.size &&
    a.lineEnding === b.lineEnding &&
    a.language === b.language &&
    a.languageChosen === b.languageChosen &&
    a.whitespace === b.whitespace &&
    a.readOnly === b.readOnly
  );
}

/** "Ln 3, Col 5", with the selection after it: "(12 selected)", "(3 lines)" or "(4 selections)". */
export function positionText(status: EditorStatus): string {
  const where = `Ln ${status.line}, Col ${status.column}`;
  if (status.selections > 1) return `${where} (${status.selections} selections)`;
  if (status.selectedCharacters) return `${where} (${status.selectedCharacters} selected)`;
  if (status.selectedLines) return `${where} (${status.selectedLines} lines)`;
  return where;
}

/** "Spaces: 2" or "Tab Size: 4", VS Code's words. */
export function indentText(indent: Indent): string {
  return indent.tabs ? `Tab Size: ${indent.size}` : `Spaces: ${indent.size}`;
}

/** "LF" or "CRLF". */
export function lineEndingText(ending: "\n" | "\r\n"): string {
  return ending === "\r\n" ? "CRLF" : "LF";
}

const names: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript JSX",
  js: "JavaScript",
  jsx: "JavaScript JSX",
  json: "JSON",
  jsonc: "JSON with Comments",
  json5: "JSON5",
  python: "Python",
  sh: "Shell",
  bash: "Bash",
  zsh: "Zsh",
  rust: "Rust",
  go: "Go",
  java: "Java",
  kotlin: "Kotlin",
  swift: "Swift",
  c: "C",
  cpp: "C++",
  cs: "C#",
};

/** A language's name as people say it. */
export function languageName(language: string | undefined): string {
  if (!language) return "Plain Text";
  return names[language] ?? language;
}
