import "monaco-editor/esm/vs/basic-languages/bat/bat.contribution";
import "monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution";
import "monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution";
import "monaco-editor/esm/vs/basic-languages/dart/dart.contribution";
import "monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution";
import "monaco-editor/esm/vs/basic-languages/go/go.contribution";
import "monaco-editor/esm/vs/basic-languages/graphql/graphql.contribution";
import "monaco-editor/esm/vs/basic-languages/hcl/hcl.contribution";
import "monaco-editor/esm/vs/basic-languages/ini/ini.contribution";
import "monaco-editor/esm/vs/basic-languages/java/java.contribution";
import "monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution";
import "monaco-editor/esm/vs/basic-languages/lua/lua.contribution";
import "monaco-editor/esm/vs/basic-languages/mdx/mdx.contribution";
import "monaco-editor/esm/vs/basic-languages/objective-c/objective-c.contribution";
import "monaco-editor/esm/vs/basic-languages/php/php.contribution";
import "monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution";
import "monaco-editor/esm/vs/basic-languages/protobuf/protobuf.contribution";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution";
import "monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution";
import "monaco-editor/esm/vs/basic-languages/rust/rust.contribution";
import "monaco-editor/esm/vs/basic-languages/scala/scala.contribution";
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution";
import "monaco-editor/esm/vs/basic-languages/solidity/solidity.contribution";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution";
import "monaco-editor/esm/vs/basic-languages/swift/swift.contribution";
import "monaco-editor/esm/vs/basic-languages/xml/xml.contribution";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution";
import { MONACO_DOTENV_LANGUAGE_ID, MONACO_PRISMA_LANGUAGE_ID } from "./workspaceLanguageMapping";

type MonacoApi = typeof import("monaco-editor");

let customLanguagesRegistered = false;

function registerPrismaLanguage(monacoInstance: MonacoApi): void {
  monacoInstance.languages.register({
    aliases: ["Prisma", "prisma"],
    extensions: [".prisma"],
    id: MONACO_PRISMA_LANGUAGE_ID,
  });
  monacoInstance.languages.setLanguageConfiguration(MONACO_PRISMA_LANGUAGE_ID, {
    autoClosingPairs: [
      { close: "}", open: "{" },
      { close: "]", open: "[" },
      { close: ")", open: "(" },
      { close: '"', open: '"' },
    ],
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
    comments: { lineComment: "//" },
    surroundingPairs: [
      { close: "}", open: "{" },
      { close: "]", open: "[" },
      { close: ")", open: "(" },
      { close: '"', open: '"' },
    ],
  });
  monacoInstance.languages.setMonarchTokensProvider(MONACO_PRISMA_LANGUAGE_ID, {
    builtinFunctions: [
      "auto",
      "autoincrement",
      "cuid",
      "dbgenerated",
      "env",
      "nanoid",
      "now",
      "sequence",
      "ulid",
      "uuid",
    ],
    builtinTypes: [
      "BigInt",
      "Boolean",
      "Bytes",
      "DateTime",
      "Decimal",
      "Float",
      "Int",
      "Json",
      "String",
      "Unsupported",
    ],
    keywords: ["datasource", "enum", "generator", "model", "type", "view"],
    tokenizer: {
      root: [
        [/^\s*\/\/\/.*$/, "comment.doc"],
        [/\/\/.*$/, "comment"],
        [/@@?[A-Za-z_]\w*/, "annotation"],
        [/^(\s*)([A-Za-z_]\w*)(\s*)(=)/, ["white", "key", "white", "operator"]],
        [/^(\s*)([A-Za-z_]\w*)(?=\s+[A-Za-z_][\w?]*(?:\[\])?)/, ["white", "key"]],
        [/^(\s*)([A-Z][A-Z0-9_]*)(?=\s*(?:\/\/.*)?$)/, ["white", "constant"]],
        [
          /\b(datasource|enum|generator|model|type|view)(\s+)([A-Za-z_]\w*)/,
          ["keyword", "white", "type.identifier"],
        ],
        [
          /\b(BigInt|Boolean|Bytes|DateTime|Decimal|Float|Int|Json|String|Unsupported)\b/,
          "type.identifier",
        ],
        [/\b(true|false|null)\b/, "keyword"],
        [
          /\b(auto|autoincrement|cuid|dbgenerated|env|nanoid|now|sequence|ulid|uuid)(?=\s*\()/,
          "predefined",
        ],
        [/[{}()[\]]/, "@brackets"],
        [/[=?:,]/, "operator"],
        [/\b(map|default|id|ignore|relation|unique|updatedat)\b(?=\s*\()/i, "annotation"],
        [/-?\d+(?:\.\d+)?/, "number"],
        [/"/, { bracket: "@open", next: "@string", token: "string.quote" }],
        [/[A-Za-z_]\w*/, "identifier"],
      ],
      string: [
        [/[^\\"]+/, "string"],
        [/\\./, "string.escape"],
        [/"/, { bracket: "@close", next: "@pop", token: "string.quote" }],
      ],
    },
  });
}

function registerDotenvLanguage(monacoInstance: MonacoApi): void {
  monacoInstance.languages.register({
    aliases: ["dotenv", "Dotenv", "Environment Variables"],
    extensions: [".env"],
    filenames: [".env"],
    id: MONACO_DOTENV_LANGUAGE_ID,
  });
  monacoInstance.languages.setLanguageConfiguration(MONACO_DOTENV_LANGUAGE_ID, {
    autoClosingPairs: [
      { close: '"', open: '"' },
      { close: "'", open: "'" },
      { close: "}", open: "{" },
    ],
    comments: { lineComment: "#" },
    surroundingPairs: [
      { close: '"', open: '"' },
      { close: "'", open: "'" },
      { close: "}", open: "{" },
    ],
  });
  monacoInstance.languages.setMonarchTokensProvider(MONACO_DOTENV_LANGUAGE_ID, {
    tokenizer: {
      root: [
        [/^\s*#.*$/, "comment"],
        [/^\s*(export)(\s+)/, ["keyword", "white"]],
        [/^\s*([A-Za-z_][\w.]*)\s*(=)/, ["key", "operator"]],
        [/\$\{[A-Za-z_][\w.]*\}/, "variable"],
        [/\$[A-Za-z_][\w.]*/, "variable"],
        [/"/, { bracket: "@open", next: "@doubleQuoted", token: "string.quote" }],
        [/'/, { bracket: "@open", next: "@singleQuoted", token: "string.quote" }],
        [/[^#\s]+/, "string"],
      ],
      doubleQuoted: [
        [/\$\{[A-Za-z_][\w.]*\}/, "variable"],
        [/\$[A-Za-z_][\w.]*/, "variable"],
        [/[^\\"$]+/, "string"],
        [/\\./, "string.escape"],
        [/"/, { bracket: "@close", next: "@pop", token: "string.quote" }],
      ],
      singleQuoted: [
        [/[^\\']+/, "string"],
        [/\\./, "string.escape"],
        [/'/, { bracket: "@close", next: "@pop", token: "string.quote" }],
      ],
    },
  });
}

export function registerWorkspaceEditorLanguages(monacoInstance: MonacoApi): void {
  if (customLanguagesRegistered) {
    return;
  }
  registerPrismaLanguage(monacoInstance);
  registerDotenvLanguage(monacoInstance);
  customLanguagesRegistered = true;
}
