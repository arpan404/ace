import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import type { CodeToken } from "./highlight.ts";

// Settled code fences and file viewers load this module. Grammars load individually in the worker,
// while both schemes are tokenized together so changing Appearance needs no new worker job.
const languages = {
  html: () => import("shiki/langs/html.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  ts: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  js: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  json5: () => import("shiki/langs/json5.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  sh: () => import("shiki/langs/shellscript.mjs"),
  bash: () => import("shiki/langs/shellscript.mjs"),
  zsh: () => import("shiki/langs/shellscript.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  cs: () => import("shiki/langs/csharp.mjs"),
} as const;
let highlighter: Promise<HighlighterCore> | undefined;
const grammars = new Map<string, Promise<string>>();

function engine() {
  highlighter ??= createHighlighterCore({
    engine: createJavaScriptRegexEngine(),
    themes: [import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")],
    langs: [],
  }).catch((error) => {
    highlighter = undefined;
    throw error;
  });
  return highlighter;
}

export async function sourceHighlight(
  code: string,
  lang: string,
): Promise<CodeToken[][] | undefined> {
  const aliases: Record<string, string> = {
    typescript: "ts",
    javascript: "js",
    mjs: "js",
    cjs: "js",
    py: "python",
    rs: "rust",
    shell: "sh",
    shellscript: "sh",
    console: "sh",
    "c++": "cpp",
    csharp: "cs",
    yml: "yaml",
    md: "markdown",
  };
  lang = aliases[lang.toLowerCase()] ?? lang.toLowerCase();
  const load = Object.entries(languages).find(([key]) => key === lang)?.[1];
  if (!load) return undefined;
  const instance = await engine();
  let grammar = grammars.get(lang);
  if (!grammar) {
    grammar = load()
      .then(async (module) => {
        await instance.loadLanguage(module);
        const name = module.default[0]?.name;
        if (!name) throw new Error("Source grammar has no name");
        return name;
      })
      .catch((error) => {
        grammars.delete(lang);
        throw error;
      });
    grammars.set(lang, grammar);
  }
  const name = await grammar;
  return instance
    .codeToTokensWithThemes(code, {
      lang: name,
      themes: { light: "github-light", dark: "github-dark" },
    })
    .map((line) =>
      line.map((token) => ({
        kind: "plain",
        text: token.content,
        light: token.variants.light?.color,
        dark: token.variants.dark?.color,
      })),
    );
}
