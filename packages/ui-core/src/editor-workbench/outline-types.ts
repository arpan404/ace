/*
 * Pure outline symbol types and tree helpers (filter, sort, flatten, caret trail).
 * No I/O or DOM dependencies so both the editor worker and UI views share one model.
 */

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "struct"
  | "interface"
  | "type"
  | "enum"
  | "const"
  | "module"
  | "heading";

export type OutlineSort = "position" | "name";

export interface OutlineSymbol {
  name: string;
  kind: SymbolKind;
  /** 1-based start line. */
  line: number;
  /** 1-based column of the symbol name. */
  column: number;
  /** 1-based inclusive end line. */
  endLine: number;
  children: readonly OutlineSymbol[];
}

export interface FlatOutlineSymbol {
  symbol: OutlineSymbol;
  depth: number;
  /** Enclosing symbol name, if any (shown as secondary context in Go to symbol). */
  container?: string | undefined;
}

/**
 * The outermost-to-innermost chain of symbols containing a 1-based `line`.
 * Used for the breadcrumbs symbol trail (`… › file.ts › Class › method`) and active Outline row.
 * `symbols` are in source order (as `extractSymbols` returns them): each level is a binary search
 * for the last symbol starting at or before `line`, so the caret's trail costs O(depth · log n)
 * and moving the caret in a large file never scans its symbols.
 */
export function symbolTrailAt(symbols: readonly OutlineSymbol[], line: number): OutlineSymbol[] {
  if (line < 1) return [];
  const trail: OutlineSymbol[] = [];
  let level = symbols;
  while (level.length > 0) {
    let low = 0;
    let high = level.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if ((level[mid]?.line ?? Infinity) <= line) {
        found = mid;
        low = mid + 1;
      } else high = mid - 1;
    }
    const match = level[found];
    if (!match || line > match.endLine) break;
    trail.push(match);
    level = match.children;
  }
  return trail;
}

/** Recursively sorts symbols by source position or case-insensitive name. */
export function sortSymbols(symbols: readonly OutlineSymbol[], sort: OutlineSort): OutlineSymbol[] {
  const copy = symbols.map((sym) =>
    sym.children.length > 0 ? { ...sym, children: sortSymbols(sym.children, sort) } : sym,
  );
  if (sort === "name") {
    copy.sort(
      (a, b) =>
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()) ||
        a.line - b.line ||
        a.column - b.column,
    );
  } else {
    copy.sort((a, b) => a.line - b.line || a.column - b.column);
  }
  return copy;
}

function matchesQuery(name: string, needle: string): boolean {
  const lower = name.toLowerCase();
  if (lower.includes(needle)) return true;
  let pos = 0;
  for (let i = 0; i < lower.length && pos < needle.length; i++) {
    if (lower[i] === needle[pos]) pos++;
  }
  return pos === needle.length;
}

/**
 * Filters a symbol tree by a query, keeping ancestors whose descendants match so the tree's
 * hierarchy stays readable while narrowing down.
 */
export function filterSymbols(symbols: readonly OutlineSymbol[], query: string): OutlineSymbol[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...symbols];
  const out: OutlineSymbol[] = [];
  for (const sym of symbols) {
    const children = filterSymbols(sym.children, needle);
    if (matchesQuery(sym.name, needle) || children.length > 0) {
      out.push(children.length === sym.children.length ? sym : { ...sym, children });
    }
  }
  return out;
}

/** Flattens a symbol tree in pre-order with depth and immediate container name. */
export function flattenSymbols(
  symbols: readonly OutlineSymbol[],
  depth = 0,
  container?: string,
): FlatOutlineSymbol[] {
  const out: FlatOutlineSymbol[] = [];
  for (const symbol of symbols) {
    out.push({ symbol, depth, container });
    if (symbol.children.length > 0) {
      out.push(...flattenSymbols(symbol.children, depth + 1, symbol.name));
    }
  }
  return out;
}
