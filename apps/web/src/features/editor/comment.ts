import { fileLanguage } from "@ace/ui-core";

/*
 * Comment tokens for a file, from the language the viewer already uses for highlighting, else
 * from its extension. A language with no line comment (CSS, HTML) comments a line with its block
 * delimiters instead; one with neither does nothing.
 */

export interface CommentTokens {
  line?: string;
  block?: readonly [open: string, close: string];
}

const cBlock = ["/*", "*/"] as const;
const htmlBlock = ["<!--", "-->"] as const;

const slash: CommentTokens = { line: "//", block: cBlock };
const hash: CommentTokens = { line: "#" };

const byLanguage: Record<string, CommentTokens> = {
  ts: slash,
  tsx: slash,
  js: slash,
  jsx: slash,
  json: slash,
  jsonc: slash,
  json5: slash,
  rust: slash,
  rs: slash,
  go: slash,
  java: slash,
  kotlin: slash,
  kt: slash,
  swift: slash,
  c: slash,
  h: slash,
  cpp: slash,
  cc: slash,
  hpp: slash,
  cs: slash,
  scss: slash,
  less: slash,
  php: slash,
  dart: slash,
  scala: slash,
  zig: { line: "//" },
  css: { block: cBlock },
  html: { block: htmlBlock },
  htm: { block: htmlBlock },
  xml: { block: htmlBlock },
  svg: { block: htmlBlock },
  vue: { block: htmlBlock },
  svelte: { block: htmlBlock },
  md: { block: htmlBlock },
  markdown: { block: htmlBlock },
  python: hash,
  py: hash,
  sh: hash,
  bash: hash,
  zsh: hash,
  fish: hash,
  ruby: hash,
  rb: hash,
  yaml: hash,
  yml: hash,
  toml: hash,
  r: hash,
  pl: hash,
  makefile: hash,
  dockerfile: hash,
  sql: { line: "--", block: cBlock },
  lua: { line: "--", block: ["--[[", "]]"] },
  hs: { line: "--", block: ["{-", "-}"] },
};

/** The comment tokens for this file's language, if it has any. */
export function commentTokens(path: string): CommentTokens | undefined {
  const language = fileLanguage(path);
  if (language && byLanguage[language]) return byLanguage[language];
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? byLanguage[name.slice(dot + 1)] : byLanguage[name];
}

/** The token Cmd+/ puts at the start of a line for this file, if its language has one. */
export function commentToken(path: string): string | undefined {
  return commentTokens(path)?.line;
}
