/*
 * Rust, Python, Markdown, and Go symbol extractors shared with `outline.ts`.
 */
import { goScanStyle, rustScanStyle, scanBraceLines } from "./outline-scan.ts";
import type { OutlineSymbol, SymbolKind } from "./outline-types.ts";

export interface MutableSymbol {
  name: string;
  kind: SymbolKind;
  line: number;
  column: number;
  endLine: number;
  children: MutableSymbol[];
  closeDepth: number;
  container: boolean;
}

export function columnOf(line: string, name: string, from = 0): number {
  const idx = line.indexOf(name, from);
  return idx >= 0 ? idx + 1 : 1;
}

export function attachSymbol(
  roots: MutableSymbol[],
  stack: MutableSymbol[],
  sym: MutableSymbol,
  sameLineClosed: boolean,
): void {
  let parent: MutableSymbol | undefined;
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i]?.container) {
      parent = stack[i];
      break;
    }
  }
  if (parent) parent.children.push(sym);
  else roots.push(sym);
  if (!sameLineClosed) stack.push(sym);
}

export function closeFinishedBraceScopes(
  stack: MutableSymbol[],
  endDepth: number,
  lineNo: number,
): void {
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (!top || endDepth > top.closeDepth) break;
    top.endLine = lineNo;
    stack.pop();
  }
}

export function closeRemainingScopes(stack: MutableSymbol[], lastLine: number): void {
  while (stack.length > 0) {
    const top = stack.pop();
    if (top) top.endLine = lastLine;
  }
}

export function finalizeSymbols(nodes: readonly MutableSymbol[]): OutlineSymbol[] {
  return nodes.map((node) => ({
    name: node.name,
    kind: node.kind,
    line: node.line,
    column: node.column,
    endLine: node.endLine,
    children: node.children.length > 0 ? finalizeSymbols(node.children) : [],
  }));
}

const rustFnRe =
  /^(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern(?:\s+"[^"]*")?\s+)?fn\s+([A-Za-z_]\w*)/;
const rustStructRe = /^(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/;
const rustEnumRe = /^(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/;
const rustTraitRe = /^(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?trait\s+([A-Za-z_]\w*)/;
const rustTypeRe = /^(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)/;
const rustConstRe = /^(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+(?:mut\s+)?([A-Za-z_]\w*)/;
const rustModRe = /^(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)/;
const rustImplRe = /^(?:unsafe\s+)?impl(?:<[^>]*>)?\s+([^{]+)/;

function formatRustImplName(rawTarget: string): string {
  const cleaned = rawTarget
    .replace(/\bwhere\b[\s\S]*$/, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? `impl ${cleaned}` : "impl";
}

export function extractRust(lines: readonly string[]): OutlineSymbol[] {
  const scanned = scanBraceLines(lines, rustScanStyle);
  const roots: MutableSymbol[] = [];
  const stack: MutableSymbol[] = [];

  for (let i = 0; i < scanned.length; i++) {
    const entry = scanned[i];
    if (!entry) continue;
    const lineNo = i + 1;
    const trimmed = entry.code.trimStart();
    if (trimmed.length === 0 || trimmed.startsWith("#[") || trimmed.startsWith("#![")) {
      closeFinishedBraceScopes(stack, entry.endDepth, lineNo);
      continue;
    }

    const offset = entry.code.length - trimmed.length;
    const containerTop = stack[stack.length - 1];
    const atContainerLevel =
      containerTop === undefined
        ? entry.startDepth === 0
        : containerTop.container && entry.startDepth === containerTop.closeDepth + 1;

    if (atContainerLevel) {
      let sym: MutableSymbol | undefined;
      let expectsBlock = false;
      let match: RegExpExecArray | null = null;

      if ((match = rustFnRe.exec(trimmed)) && match[1]) {
        const insideType =
          containerTop !== undefined &&
          (containerTop.kind === "class" || containerTop.kind === "interface");
        expectsBlock = entry.openedBrace || !trimmed.endsWith(";");
        sym = {
          name: match[1],
          kind: insideType ? "method" : "function",
          line: lineNo,
          column: columnOf(entry.code, match[1], offset),
          endLine: lineNo,
          children: [],
          closeDepth: entry.startDepth,
          container: false,
        };
      } else if ((match = rustImplRe.exec(trimmed)) && match[1]) {
        expectsBlock = true;
        sym = {
          name: formatRustImplName(match[1]),
          kind: "class",
          line: lineNo,
          column: offset + 1,
          endLine: lineNo,
          children: [],
          closeDepth: entry.startDepth,
          container: true,
        };
      } else if ((match = rustStructRe.exec(trimmed)) && match[1]) {
        expectsBlock = entry.openedBrace;
        sym = {
          name: match[1],
          kind: "struct",
          line: lineNo,
          column: columnOf(entry.code, match[1], offset),
          endLine: lineNo,
          children: [],
          closeDepth: entry.startDepth,
          container: false,
        };
      } else if ((match = rustEnumRe.exec(trimmed)) && match[1]) {
        expectsBlock = entry.openedBrace;
        sym = {
          name: match[1],
          kind: "enum",
          line: lineNo,
          column: columnOf(entry.code, match[1], offset),
          endLine: lineNo,
          children: [],
          closeDepth: entry.startDepth,
          container: false,
        };
      } else if ((match = rustTraitRe.exec(trimmed)) && match[1]) {
        expectsBlock = entry.openedBrace;
        sym = {
          name: match[1],
          kind: "interface",
          line: lineNo,
          column: columnOf(entry.code, match[1], offset),
          endLine: lineNo,
          children: [],
          closeDepth: entry.startDepth,
          container: true,
        };
      } else if ((match = rustModRe.exec(trimmed)) && match[1]) {
        expectsBlock = entry.openedBrace;
        sym = {
          name: match[1],
          kind: "module",
          line: lineNo,
          column: columnOf(entry.code, match[1], offset),
          endLine: lineNo,
          children: [],
          closeDepth: entry.startDepth,
          container: entry.openedBrace,
        };
      } else if ((match = rustTypeRe.exec(trimmed)) && match[1]) {
        sym = {
          name: match[1],
          kind: "type",
          line: lineNo,
          column: columnOf(entry.code, match[1], offset),
          endLine: lineNo,
          children: [],
          closeDepth: entry.startDepth,
          container: false,
        };
      } else if ((match = rustConstRe.exec(trimmed)) && match[1]) {
        sym = {
          name: match[1],
          kind: "const",
          line: lineNo,
          column: columnOf(entry.code, match[1], offset),
          endLine: lineNo,
          children: [],
          closeDepth: entry.startDepth,
          container: false,
        };
      }

      if (sym) {
        const sameLineClosed =
          !expectsBlock || (entry.openedBrace && entry.minDepthAfterOpen <= sym.closeDepth);
        attachSymbol(roots, stack, sym, sameLineClosed);
      }
    }

    if (entry.endDepth <= entry.startDepth) {
      closeFinishedBraceScopes(stack, entry.endDepth, lineNo);
    }
  }

  closeRemainingScopes(stack, Math.max(1, lines.length));
  return finalizeSymbols(roots);
}

const pyClassRe = /^class\s+([A-Za-z_]\w*)\b/;
const pyDefRe = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;
const pyConstRe = /^([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=/;

function measureIndent(line: string): number {
  let width = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === " ") width++;
    else if (line[i] === "\t") width += 4;
    else break;
  }
  return width;
}

function toggleTripleQuote(
  line: string,
  current: '"""' | "'''" | undefined,
): '"""' | "'''" | undefined {
  let state = current;
  for (let i = 0; i < line.length; i++) {
    if (!state && line[i] === "#") break;
    if (line[i] === "\\" && state) {
      i++;
      continue;
    }
    const triple = line.slice(i, i + 3);
    if (state) {
      if (triple === state) {
        state = undefined;
        i += 2;
      }
    } else if (triple === '"""' || triple === "'''") {
      state = triple;
      i += 2;
    }
  }
  return state;
}

export function extractPython(lines: readonly string[]): OutlineSymbol[] {
  const roots: MutableSymbol[] = [];
  const stack: MutableSymbol[] = [];
  let tripleQuote: '"""' | "'''" | undefined;
  let lastCodeLine = 1;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const lineNo = i + 1;

    if (tripleQuote) {
      tripleQuote = toggleTripleQuote(raw, tripleQuote);
      lastCodeLine = lineNo;
      continue;
    }

    const trimmed = raw.trimStart();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

    const indent = measureIndent(raw);
    const offset = raw.length - trimmed.length;

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (!top || indent > top.closeDepth) break;
      top.endLine = lastCodeLine;
      stack.pop();
    }

    let match: RegExpExecArray | null = null;
    if ((match = pyClassRe.exec(trimmed)) && match[1]) {
      attachSymbol(
        roots,
        stack,
        {
          name: match[1],
          kind: "class",
          line: lineNo,
          column: columnOf(raw, match[1], offset),
          endLine: lineNo,
          children: [],
          closeDepth: indent,
          container: true,
        },
        false,
      );
    } else if ((match = pyDefRe.exec(trimmed)) && match[1]) {
      const parent = stack[stack.length - 1];
      attachSymbol(
        roots,
        stack,
        {
          name: match[1],
          kind: parent?.kind === "class" ? "method" : "function",
          line: lineNo,
          column: columnOf(raw, match[1], offset),
          endLine: lineNo,
          children: [],
          closeDepth: indent,
          container: true,
        },
        false,
      );
    } else if (indent === 0 && (match = pyConstRe.exec(trimmed)) && match[1]) {
      roots.push({
        name: match[1],
        kind: "const",
        line: lineNo,
        column: offset + 1,
        endLine: lineNo,
        children: [],
        closeDepth: 0,
        container: false,
      });
    }

    tripleQuote = toggleTripleQuote(trimmed, undefined);
    lastCodeLine = lineNo;
  }

  closeRemainingScopes(stack, lastCodeLine);
  return finalizeSymbols(roots);
}

const mdFenceRe = /^[ \t]{0,3}(`{3,}|~{3,})/;
const mdHeadingRe = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;

export function extractMarkdown(lines: readonly string[]): OutlineSymbol[] {
  const roots: MutableSymbol[] = [];
  const stack: { sym: MutableSymbol; level: number }[] = [];
  let fenceChar: "`" | "~" | undefined;
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const lineNo = i + 1;

    const fence = mdFenceRe.exec(raw);
    if (fence && fence[1]) {
      const ch = fence[1][0] as "`" | "~";
      const len = fence[1].length;
      if (!fenceChar) {
        fenceChar = ch;
        fenceLen = len;
        continue;
      }
      if (ch === fenceChar && len >= fenceLen && raw.trim().length === len) {
        fenceChar = undefined;
        fenceLen = 0;
        continue;
      }
    }
    if (fenceChar) continue;

    const heading = mdHeadingRe.exec(raw);
    if (!heading || !heading[1] || !heading[2]) continue;

    const level = heading[1].length;
    const name = heading[2].trim();
    if (!name) continue;

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (!top || top.level < level) break;
      top.sym.endLine = Math.max(top.sym.line, lineNo - 1);
      stack.pop();
    }

    const sym: MutableSymbol = {
      name,
      kind: "heading",
      line: lineNo,
      column: raw.indexOf(name) + 1,
      endLine: Math.max(1, lines.length),
      children: [],
      closeDepth: level,
      container: true,
    };

    const parent = stack[stack.length - 1]?.sym;
    if (parent) parent.children.push(sym);
    else roots.push(sym);
    stack.push({ sym, level });
  }

  const lastLine = Math.max(1, lines.length);
  for (const item of stack) item.sym.endLine = lastLine;
  return finalizeSymbols(roots);
}

const goMethodRe = /^func\s+\([^)]*\)\s+([A-Za-z_]\w*)\s*\(/;
const goFuncRe = /^func\s+([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\(/;
const goStructRe = /^type\s+([A-Za-z_]\w*)\s+struct\b/;
const goInterfaceRe = /^type\s+([A-Za-z_]\w*)\s+interface\b/;
const goTypeRe = /^type\s+([A-Za-z_]\w*)\b/;
const goConstRe = /^const\s+([A-Za-z_]\w*)\b/;

export function extractGo(lines: readonly string[]): OutlineSymbol[] {
  const scanned = scanBraceLines(lines, goScanStyle);
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

    if (entry.startDepth === 0) {
      const offset = entry.code.length - trimmed.length;
      let match: RegExpExecArray | null = null;
      let kind: SymbolKind | undefined;
      if ((match = goMethodRe.exec(trimmed))) kind = "method";
      else if ((match = goFuncRe.exec(trimmed))) kind = "function";
      else if ((match = goStructRe.exec(trimmed))) kind = "struct";
      else if ((match = goInterfaceRe.exec(trimmed))) kind = "interface";
      else if ((match = goTypeRe.exec(trimmed))) kind = "type";
      else if ((match = goConstRe.exec(trimmed))) kind = "const";

      if (match && match[1] && kind) {
        const sym: MutableSymbol = {
          name: match[1],
          kind,
          line: lineNo,
          column: columnOf(entry.code, match[1], offset),
          endLine: lineNo,
          children: [],
          closeDepth: 0,
          container: false,
        };
        const sameLineClosed = !entry.openedBrace || entry.minDepthAfterOpen <= 0;
        attachSymbol(roots, stack, sym, sameLineClosed);
      }
    }

    if (entry.endDepth <= entry.startDepth) {
      closeFinishedBraceScopes(stack, entry.endDepth, lineNo);
    }
  }

  closeRemainingScopes(stack, Math.max(1, lines.length));
  return finalizeSymbols(roots);
}
