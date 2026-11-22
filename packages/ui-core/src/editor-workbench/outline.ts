/*
 * Per-language symbol extraction for the editor Outline, breadcrumbs symbol trail, and Go to
 * symbol picker. Pure and single-pass so it runs safely off the main thread in the editor worker
 * and finishes 20,000-line files in milliseconds.
 */
import {
  attachSymbol,
  closeFinishedBraceScopes,
  closeRemainingScopes,
  columnOf,
  extractGo,
  extractMarkdown,
  extractPython,
  extractRust,
  finalizeSymbols,
  type MutableSymbol,
} from "./outline-languages.ts";
import { scanBraceLines, tsScanStyle } from "./outline-scan.ts";
import type { OutlineSymbol, SymbolKind } from "./outline-types.ts";

export * from "./outline-types.ts";

type LanguageFamily = "ts" | "rust" | "python" | "markdown" | "go" | "none";

const tsKeywords = new Set([
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "default",
  "try",
  "catch",
  "finally",
  "return",
  "throw",
  "new",
  "super",
  "typeof",
  "delete",
  "void",
  "await",
  "yield",
  "import",
  "export",
  "class",
  "function",
  "interface",
  "type",
  "enum",
  "const",
  "let",
  "var",
  "namespace",
]);

function resolveFamily(languageOrPath: string | undefined): LanguageFamily {
  if (!languageOrPath) return "none";
  const lower = languageOrPath.toLowerCase();
  const base = lower.includes("/") ? (lower.slice(lower.lastIndexOf("/") + 1) ?? lower) : lower;
  const dot = base.lastIndexOf(".");
  const key = dot >= 0 ? base.slice(dot + 1) : base;
  switch (key) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
    case "typescript":
    case "typescriptreact":
    case "javascript":
    case "javascriptreact":
      return "ts";
    case "rs":
    case "rust":
      return "rust";
    case "py":
    case "pyi":
    case "python":
      return "python";
    case "md":
    case "mdx":
    case "markdown":
      return "markdown";
    case "go":
    case "golang":
      return "go";
    default:
      return "none";
  }
}

const tsFunctionRe =
  /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/;
const tsClassRe =
  /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/;
const tsInterfaceRe = /^(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/;
const tsTypeRe = /^(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*=/;
const tsEnumRe = /^(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/;
const tsConstRe = /^(?:export\s+)?(?:declare\s+)?const\s+([A-Za-z_$][\w$]*)\b/;
const tsClassMethodRe =
  /^(?:(?:public|private|protected|static|readonly|abstract|override|async|declare)\s+)*(?:(?:get|set)\s+)?\*?\s*(#[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;
const tsClassArrowRe =
  /^(?:(?:public|private|protected|static|readonly|override|declare)\s+)*(#[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/;

function extractTs(lines: readonly string[]): OutlineSymbol[] {
  const scanned = scanBraceLines(lines, tsScanStyle);
  const roots: MutableSymbol[] = [];
  const stack: MutableSymbol[] = [];

  for (let i = 0; i < scanned.length; i++) {
    const entry = scanned[i];
    if (!entry) continue;
    const lineNo = i + 1;
    const trimmed = entry.code.trimStart();
    if (trimmed.length === 0) {
      closeFinishedBraceScopes(stack, entry.endDepth, lineNo);
      continue;
    }

    const offset = entry.code.length - trimmed.length;
    const enclosing = stack[stack.length - 1];
    const inClassBody =
      enclosing !== undefined &&
      enclosing.kind === "class" &&
      entry.startDepth === enclosing.closeDepth + 1;

    let sym: MutableSymbol | undefined;
    let expectsBlock = false;

    if (inClassBody) {
      const arrowMatch = tsClassArrowRe.exec(trimmed);
      const methodMatch = arrowMatch ? null : tsClassMethodRe.exec(trimmed);
      const name = arrowMatch?.[1] ?? methodMatch?.[1];
      if (name && !tsKeywords.has(name)) {
        expectsBlock = entry.openedBrace;
        sym = {
          name,
          kind: "method",
          line: lineNo,
          column: columnOf(entry.code, name, offset),
          endLine: lineNo,
          children: [],
          closeDepth: entry.startDepth,
          container: false,
        };
      }
    } else if (entry.startDepth === 0) {
      let match: RegExpExecArray | null = null;
      let kind: SymbolKind | undefined;
      let container = false;

      if ((match = tsFunctionRe.exec(trimmed))) {
        kind = "function";
        expectsBlock = entry.openedBrace || !trimmed.endsWith(";");
      } else if ((match = tsClassRe.exec(trimmed))) {
        kind = "class";
        container = true;
        expectsBlock = true;
      } else if ((match = tsInterfaceRe.exec(trimmed))) {
        kind = "interface";
        expectsBlock = entry.openedBrace;
      } else if ((match = tsTypeRe.exec(trimmed))) {
        kind = "type";
        expectsBlock = entry.openedBrace;
      } else if ((match = tsEnumRe.exec(trimmed))) {
        kind = "enum";
        expectsBlock = entry.openedBrace;
      } else if ((match = tsConstRe.exec(trimmed))) {
        const afterName = trimmed.slice(match[0].length);
        const isFunc = /=>/.test(afterName) || /\b(?:async\s+)?function\b/.test(afterName);
        kind = isFunc ? "function" : "const";
        expectsBlock = entry.openedBrace;
      }

      if (match && match[1] && kind) {
        sym = {
          name: match[1],
          kind,
          line: lineNo,
          column: columnOf(entry.code, match[1], offset),
          endLine: lineNo,
          children: [],
          closeDepth: entry.startDepth,
          container,
        };
      }
    }

    if (sym) {
      const sameLineClosed =
        !expectsBlock || (entry.openedBrace && entry.minDepthAfterOpen <= sym.closeDepth);
      attachSymbol(roots, stack, sym, sameLineClosed);
    }

    if (entry.endDepth <= entry.startDepth) {
      closeFinishedBraceScopes(stack, entry.endDepth, lineNo);
    }
  }

  closeRemainingScopes(stack, Math.max(1, lines.length));
  return finalizeSymbols(roots);
}

/**
 * Extracts document symbols for `text`, given either a language id (`"ts"`, `"rust"`, `"python"`,
 * `"markdown"`, `"go"`) or a file path (`"src/app.tsx"`).
 */
export function extractSymbols(text: string, languageOrPath: string | undefined): OutlineSymbol[] {
  if (!text) return [];
  const family = resolveFamily(languageOrPath);
  if (family === "none") return [];
  const lines = text.split(/\r?\n/);
  switch (family) {
    case "ts":
      return extractTs(lines);
    case "rust":
      return extractRust(lines);
    case "python":
      return extractPython(lines);
    case "markdown":
      return extractMarkdown(lines);
    case "go":
      return extractGo(lines);
  }
}
