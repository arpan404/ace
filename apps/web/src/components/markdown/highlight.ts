/**
 * A small tokenizer for code blocks. The design is near-monochrome, so tokens map to tone and
 * weight, not hue: keywords in full ink, strings and numbers muted, comments subtle.
 */
export type TokenKind = "plain" | "keyword" | "string" | "number" | "comment" | "punct";
export interface CodeToken {
  kind: TokenKind;
  text: string;
}

const cLike = new Set(
  (
    "abstract as async await break case catch class const continue debugger default delete do " +
    "else enum export extends false finally for from function if implements import in " +
    "instanceof interface let new null of package private protected public readonly return " +
    "satisfies static super switch this throw true try type typeof undefined var void while " +
    "with yield fn impl mut pub struct use match loop where self Self trait mod crate func " +
    "go chan defer map range select package"
  ).split(" "),
);
const python = new Set(
  (
    "and as assert async await break class continue def del elif else except False finally for " +
    "from global if import in is lambda None nonlocal not or pass raise return True try while " +
    "with yield self"
  ).split(" "),
);
const shell = new Set(
  "if then else elif fi for in do done case esac while until function export local return echo cd".split(
    " ",
  ),
);

type Family = "c" | "python" | "shell" | "json" | "plain";

export function languageFamily(lang: string | undefined): Family {
  const name = (lang ?? "").toLowerCase();
  if (["ts", "tsx", "js", "jsx", "javascript", "typescript", "mjs", "cjs"].includes(name))
    return "c";
  if (["rust", "rs", "go", "java", "c", "cpp", "c++", "swift", "kotlin", "cs"].includes(name))
    return "c";
  if (["py", "python"].includes(name)) return "python";
  if (["sh", "bash", "zsh", "shell", "console"].includes(name)) return "shell";
  if (["json", "jsonc", "json5"].includes(name)) return "json";
  return "plain";
}

const patterns: Record<Exclude<Family, "plain">, RegExp> = {
  c: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|([{}()[\];,.<>=+\-*/%!&|?:])/g,
  python:
    /(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_][\w]*)|([{}()[\];,.<>=+\-*/%!&|:])/g,
  shell: /(#[^\n]*)|("(?:\\.|[^"\\])*"|'[^']*')|(\b\d+\b)|([A-Za-z_][\w-]*)|([|&;<>()$=])/g,
  json: /()("(?:\\.|[^"\\\n])*")|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(true|false|null)|([{}[\],:])/g,
};
const keywords: Record<Exclude<Family, "plain">, ReadonlySet<string>> = {
  c: cLike,
  python,
  shell,
  json: new Set(["true", "false", "null"]),
};

/** Splits `code` into tokens whose texts concatenate back to `code`. */
export function highlight(code: string, lang: string | undefined): CodeToken[] {
  const family = languageFamily(lang);
  if (family === "plain") return [{ kind: "plain", text: code }];
  const pattern = new RegExp(patterns[family].source, "g");
  const words = keywords[family];
  const tokens: CodeToken[] = [];
  const push = (kind: TokenKind, text: string) => {
    const last = tokens.at(-1);
    if (last && last.kind === kind) last.text += text;
    else tokens.push({ kind, text });
  };
  let index = 0;
  for (const match of code.matchAll(pattern)) {
    const at = match.index;
    if (at > index) push("plain", code.slice(index, at));
    const [text, comment, string, number, word] = match;
    if (comment) push("comment", text);
    else if (string) push("string", text);
    else if (number) push("number", text);
    else if (word) push(words.has(word) ? "keyword" : "plain", text);
    else push("punct", text);
    index = at + text.length;
  }
  if (index < code.length) push("plain", code.slice(index));
  return tokens;
}
