import { fileLanguage } from "@ace/ui-core";

/*
 * The line-comment token for a file, from the language the viewer already uses for
 * highlighting. Languages that have none (CSS, HTML, Markdown fences) return undefined and the
 * shortcut does nothing there.
 */

const tokens: Record<string, string> = {
  ts: "//",
  tsx: "//",
  js: "//",
  jsx: "//",
  json: "//",
  jsonc: "//",
  json5: "//",
  rust: "//",
  go: "//",
  java: "//",
  kotlin: "//",
  swift: "//",
  c: "//",
  cpp: "//",
  cs: "//",
  python: "#",
  sh: "#",
  bash: "#",
  zsh: "#",
  ruby: "#",
  rb: "#",
  yaml: "#",
  yml: "#",
  toml: "#",
  sql: "--",
  lua: "--",
};

/** The token Cmd+/ puts at the start of a line for this file, if its language has one. */
export function commentToken(path: string): string | undefined {
  const language = fileLanguage(path);
  if (language) return tokens[language];
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? tokens[name.slice(dot + 1)] : tokens[name];
}
