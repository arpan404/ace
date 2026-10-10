import type { Token, TokenStream } from "prismjs";
import type { CodeToken } from "./highlight.ts";

// The grammar engine stays off both the first paint and streamed plain fences. Both theme
// variants travel in the token result, so changing Appearance does not restart tokenization.
let engine: Promise<typeof import("./source-grammars.ts")> | undefined;
function loadEngine() {
  if (!engine) {
    // Prism assumes it owns a worker unless these flags exist before its core executes.
    // ace owns the worker protocol and React owns every rendered source node.
    Object.assign(globalThis, { Prism: { manual: true, disableWorkerMessageHandler: true } });
    engine = import("./source-grammars.ts").catch((error) => {
      engine = undefined;
      throw error;
    });
  }
  return engine;
}

const aliases: Record<string, string> = {
  html: "markup",
  xml: "markup",
  svg: "markup",
  ts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rs: "rust",
  sh: "bash",
  zsh: "bash",
  shell: "bash",
  shellscript: "bash",
  console: "bash",
  "c++": "cpp",
  cs: "csharp",
  yml: "yaml",
  md: "markdown",
  jsonc: "json",
};
const palette: Record<string, readonly [string, string]> = {
  comment: ["#6e7781", "#8b949e"],
  prolog: ["#6e7781", "#8b949e"],
  keyword: ["#cf222e", "#ff7b72"],
  boolean: ["#0550ae", "#79c0ff"],
  number: ["#0550ae", "#79c0ff"],
  constant: ["#0550ae", "#79c0ff"],
  string: ["#0a3069", "#a5d6ff"],
  "attr-value": ["#0a3069", "#a5d6ff"],
  regex: ["#0a3069", "#a5d6ff"],
  char: ["#0a3069", "#a5d6ff"],
  function: ["#8250df", "#d2a8ff"],
  "class-name": ["#953800", "#ffa657"],
  property: ["#0550ae", "#79c0ff"],
  "attr-name": ["#0550ae", "#79c0ff"],
  tag: ["#116329", "#7ee787"],
  selector: ["#116329", "#7ee787"],
  punctuation: ["#24292f", "#c9d1d9"],
  operator: ["#24292f", "#c9d1d9"],
};

/** Flatten grammar tokens into text, never HTML. Nested strings inherit their parent's color. */
function appendTokens(
  value: TokenStream,
  lines: CodeToken[][],
  inherited?: readonly [string, string],
) {
  if (Array.isArray(value)) {
    for (const part of value) appendTokens(part, lines, inherited);
    return;
  }
  if (typeof value !== "string") {
    const token: Token = value;
    const names = [
      token.type,
      ...(typeof token.alias === "string" ? [token.alias] : (token.alias ?? [])),
    ];
    const color = names.map((name) => palette[name]).find(Boolean) ?? inherited;
    appendTokens(token.content, lines, color);
    return;
  }
  value.split("\n").forEach((text, index) => {
    if (index) lines.push([]);
    if (text)
      lines.at(-1)?.push({ kind: "plain", text, light: inherited?.[0], dark: inherited?.[1] });
  });
}

export async function sourceHighlight(
  code: string,
  lang: string,
): Promise<CodeToken[][] | undefined> {
  const { Prism } = await loadEngine();
  const name = aliases[lang.toLowerCase()] ?? lang.toLowerCase();
  const grammar = Prism.languages[name];
  if (!grammar || typeof grammar === "function") return undefined;
  const lines: CodeToken[][] = [[]];
  appendTokens(Prism.tokenize(code, grammar), lines);
  return lines;
}
