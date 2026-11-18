/*
 * SQLite's lexical structure, as much as the migration lint needs: keywords and bare names,
 * quoted names in every SQLite form ("x", [x], `x`), string literals, line comments, and
 * punctuation. Block comments are dropped. Pure.
 */

export type TokenKind = "word" | "quoted" | "string" | "comment" | "other";

export interface Token {
  kind: TokenKind;
  /** The source text; for a word, upper-cased. */
  text: string;
  line: number;
}

/** The index just past a quoted run that closes with `close`, a doubled `close` escaping it. */
function quotedEnd(sql: string, from: number, close: string, doubled: boolean): number {
  let index = from + 1;
  while (index < sql.length) {
    if (sql[index] === close) {
      if (doubled && sql[index + 1] === close) index += 2;
      else return index + 1;
    } else {
      index += 1;
    }
  }
  return sql.length;
}

const wordStart = /[A-Za-z_\u0080-￿]/;
const wordPart = /[A-Za-z0-9_$\u0080-￿]/;

export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let line = 1;
  let index = 0;
  const push = (kind: TokenKind, end: number) => {
    const text = sql.slice(index, end);
    tokens.push({ kind, text: kind === "word" ? text.toUpperCase() : text, line });
    line += text.split("\n").length - 1;
    index = end;
  };
  while (index < sql.length) {
    const char = sql[index] ?? "";
    if (char === "\n") {
      line += 1;
      index += 1;
    } else if (/\s/.test(char)) {
      index += 1;
    } else if (sql.startsWith("--", index)) {
      const end = sql.indexOf("\n", index);
      push("comment", end === -1 ? sql.length : end);
    } else if (sql.startsWith("/*", index)) {
      const end = sql.indexOf("*/", index + 2);
      const stop = end === -1 ? sql.length : end + 2;
      line += sql.slice(index, stop).split("\n").length - 1;
      index = stop;
    } else if (char === "'") {
      push("string", quotedEnd(sql, index, "'", true));
    } else if (char === '"' || char === "`") {
      push("quoted", quotedEnd(sql, index, char, true));
    } else if (char === "[") {
      push("quoted", quotedEnd(sql, index, "]", false));
    } else if (wordStart.test(char)) {
      let end = index + 1;
      while (end < sql.length && wordPart.test(sql[end] ?? "")) end += 1;
      push("word", end);
    } else {
      push("other", index + 1);
    }
  }
  return tokens;
}

export interface Statement {
  line: number;
  tokens: Token[];
}

export const isWord = (token: Token | undefined, text: string) =>
  token?.kind === "word" && token.text === text;

/**
 * Statements without their comments, split on `;`. A trigger's body (`BEGIN … END`) stays in its
 * CREATE TRIGGER statement.
 */
export function statements(tokens: readonly Token[]): Statement[] {
  const found: Statement[] = [];
  let current: Token[] = [];
  let inTriggerBody = false;
  let caseDepth = 0;
  const isTrigger = () =>
    isWord(current[0], "CREATE") && current.slice(1, 4).some((token) => isWord(token, "TRIGGER"));
  for (const token of tokens) {
    if (token.kind === "comment") continue;
    if (token.kind === "other" && token.text === ";" && !inTriggerBody) {
      if (current.length > 0) found.push({ line: current[0]?.line ?? 1, tokens: current });
      current = [];
      continue;
    }
    current.push(token);
    if (isWord(token, "BEGIN") && isTrigger()) inTriggerBody = true;
    else if (isWord(token, "CASE") && inTriggerBody) caseDepth += 1;
    else if (isWord(token, "END") && inTriggerBody) {
      if (caseDepth > 0) caseDepth -= 1;
      else inTriggerBody = false;
    }
  }
  if (current.length > 0) found.push({ line: current[0]?.line ?? 1, tokens: current });
  return found;
}
