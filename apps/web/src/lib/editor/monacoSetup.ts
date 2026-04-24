import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { registerWorkspaceEditorLanguages } from "./workspaceLanguages";

let monacoConfigured = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function updateLanguageDiagnosticsOptions(
  namespace: unknown,
  defaultsKey: string,
  updater: (current: Record<string, unknown>) => Record<string, unknown>,
): void {
  if (!isRecord(namespace)) {
    return;
  }
  const defaults = Reflect.get(namespace, defaultsKey);
  if (!isRecord(defaults)) {
    return;
  }
  const setDiagnosticsOptions = Reflect.get(defaults, "setDiagnosticsOptions");
  if (typeof setDiagnosticsOptions !== "function") {
    return;
  }
  const current = Reflect.get(defaults, "diagnosticsOptions");
  setDiagnosticsOptions.call(defaults, updater(isRecord(current) ? current : {}));
}

function updateLanguageOptions(
  namespace: unknown,
  defaultsKey: string,
  updater: (current: Record<string, unknown>) => Record<string, unknown>,
): void {
  if (!isRecord(namespace)) {
    return;
  }
  const defaults = Reflect.get(namespace, defaultsKey);
  if (!isRecord(defaults)) {
    return;
  }
  const setOptions = Reflect.get(defaults, "setOptions");
  if (typeof setOptions !== "function") {
    return;
  }
  const current = Reflect.get(defaults, "options");
  setOptions.call(defaults, updater(isRecord(current) ? current : {}));
}

function updateLanguageCompilerOptions(
  namespace: unknown,
  defaultsKey: string,
  updater: (current: Record<string, unknown>) => Record<string, unknown>,
): void {
  if (!isRecord(namespace)) {
    return;
  }
  const defaults = Reflect.get(namespace, defaultsKey);
  if (!isRecord(defaults)) {
    return;
  }
  const setCompilerOptions = Reflect.get(defaults, "setCompilerOptions");
  if (typeof setCompilerOptions !== "function") {
    return;
  }
  const current = Reflect.get(defaults, "compilerOptions");
  setCompilerOptions.call(defaults, updater(isRecord(current) ? current : {}));
}

function setLanguageEagerModelSync(
  namespace: unknown,
  defaultsKey: string,
  enabled: boolean,
): void {
  if (!isRecord(namespace)) {
    return;
  }
  const defaults = Reflect.get(namespace, defaultsKey);
  if (!isRecord(defaults)) {
    return;
  }
  const setEagerModelSync = Reflect.get(defaults, "setEagerModelSync");
  if (typeof setEagerModelSync !== "function") {
    return;
  }
  setEagerModelSync.call(defaults, enabled);
}

function readEnumValue(container: unknown, key: string): unknown {
  if (!isRecord(container)) {
    return undefined;
  }
  return Reflect.get(container, key);
}

export function ensureMonacoConfigured(): void {
  if (monacoConfigured) {
    return;
  }

  const environment = {
    getWorker(_: string, label: string) {
      switch (label) {
        case "css":
        case "scss":
        case "less":
          return new cssWorker();
        case "html":
        case "handlebars":
        case "razor":
          return new htmlWorker();
        case "json":
          return new jsonWorker();
        case "typescript":
        case "javascript":
          return new tsWorker();
        default:
          return new editorWorker();
      }
    },
  };

  Object.assign(globalThis as object, {
    MonacoEnvironment: environment,
  });
  loader.config({ monaco });
  registerWorkspaceEditorLanguages(monaco);
  const typescriptNamespace = Reflect.get(monaco.languages, "typescript");
  const jsonNamespace = Reflect.get(monaco.languages, "json");
  const cssNamespace = Reflect.get(monaco.languages, "css");
  const moduleKind = readEnumValue(typescriptNamespace, "ModuleKind");
  const moduleResolutionKind = readEnumValue(typescriptNamespace, "ModuleResolutionKind");
  const scriptTarget = readEnumValue(typescriptNamespace, "ScriptTarget");
  const jsxEmit = readEnumValue(typescriptNamespace, "JsxEmit");

  updateLanguageDiagnosticsOptions(typescriptNamespace, "javascriptDefaults", (current) => ({
    ...current,
    noSemanticValidation: true,
    noSuggestionDiagnostics: true,
    noSyntaxValidation: true,
  }));
  updateLanguageDiagnosticsOptions(typescriptNamespace, "typescriptDefaults", (current) => ({
    ...current,
    noSemanticValidation: true,
    noSuggestionDiagnostics: true,
    noSyntaxValidation: true,
  }));
  updateLanguageCompilerOptions(typescriptNamespace, "javascriptDefaults", (current) => ({
    ...current,
    allowJs: true,
    allowNonTsExtensions: true,
    checkJs: true,
    jsx: readEnumValue(jsxEmit, "ReactJSX") ?? current.jsx,
    module: readEnumValue(moduleKind, "ESNext") ?? current.module,
    moduleResolution: readEnumValue(moduleResolutionKind, "NodeJs") ?? current.moduleResolution,
    noEmit: true,
    resolveJsonModule: true,
    target: readEnumValue(scriptTarget, "ESNext") ?? current.target,
  }));
  updateLanguageCompilerOptions(typescriptNamespace, "typescriptDefaults", (current) => ({
    ...current,
    allowJs: true,
    allowNonTsExtensions: true,
    jsx: readEnumValue(jsxEmit, "ReactJSX") ?? current.jsx,
    module: readEnumValue(moduleKind, "ESNext") ?? current.module,
    moduleResolution: readEnumValue(moduleResolutionKind, "NodeJs") ?? current.moduleResolution,
    noEmit: true,
    resolveJsonModule: true,
    target: readEnumValue(scriptTarget, "ESNext") ?? current.target,
  }));
  setLanguageEagerModelSync(typescriptNamespace, "javascriptDefaults", true);
  setLanguageEagerModelSync(typescriptNamespace, "typescriptDefaults", true);
  updateLanguageDiagnosticsOptions(jsonNamespace, "jsonDefaults", (current) => ({
    ...current,
    schemaRequest: "ignore",
    schemaValidation: "ignore",
    validate: false,
  }));
  updateLanguageOptions(cssNamespace, "cssDefaults", (current) => ({
    ...current,
    validate: false,
  }));
  updateLanguageOptions(cssNamespace, "scssDefaults", (current) => ({
    ...current,
    validate: false,
  }));
  updateLanguageOptions(cssNamespace, "lessDefaults", (current) => ({
    ...current,
    validate: false,
  }));
  monaco.editor.defineTheme("ace-carbon", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6A9955" },
      { token: "comment.doc", foreground: "7FA36B" },
      { token: "keyword", foreground: "569CD6" },
      { token: "keyword.control", foreground: "C586C0" },
      { token: "annotation", foreground: "D7BA7D" },
      { token: "attribute.name", foreground: "9CDCFE" },
      { token: "attribute.value", foreground: "CE9178" },
      { token: "class-name", foreground: "4EC9B0" },
      { token: "constant", foreground: "4FC1FF" },
      { token: "constructor", foreground: "DCDCAA" },
      { token: "function", foreground: "DCDCAA" },
      { token: "function.call", foreground: "DCDCAA" },
      { token: "invalid", foreground: "F44747" },
      { token: "key", foreground: "9CDCFE" },
      { token: "key.identifier", foreground: "9CDCFE" },
      { token: "namespace", foreground: "4EC9B0" },
      { token: "regexp", foreground: "D16969" },
      { token: "predefined", foreground: "DCDCAA" },
      { token: "string", foreground: "CE9178" },
      { token: "string.escape", foreground: "D7BA7D" },
      { token: "tag", foreground: "569CD6" },
      { token: "tag.name", foreground: "569CD6" },
      { token: "number", foreground: "B5CEA8" },
      { token: "type", foreground: "4EC9B0" },
      { token: "type.identifier", foreground: "4EC9B0" },
      { token: "variable", foreground: "C586C0" },
      { token: "variable.parameter", foreground: "9CDCFE" },
      { token: "delimiter", foreground: "D4D4D4" },
      { token: "delimiter.bracket", foreground: "D4D4D4" },
      { token: "operator", foreground: "D4D4D4" },
    ],
    colors: {
      "editor.background": "#1E1E1E",
      "editor.foreground": "#D4D4D4",
      "editor.lineHighlightBackground": "#2A2D2E",
      "editor.selectionBackground": "#264F78",
      "editor.selectionHighlightBackground": "#335A7A66",
      "editor.selectionHighlightBorder": "#74A9E833",
      "editor.inactiveSelectionBackground": "#3A3D41",
      "editorCursor.foreground": "#AEAFAD",
      "editorWhitespace.foreground": "#3B3B3B",
      "editorIndentGuide.background1": "#404040",
      "editorIndentGuide.activeBackground1": "#707070",
      "editorLineNumber.foreground": "#858585",
      "editorLineNumber.activeForeground": "#C6C6C6",
      "editor.wordHighlightBackground": "#2F5D8C4D",
      "editor.wordHighlightBorder": "#5C93D1AA",
      "editor.wordHighlightStrongBackground": "#3D7AAC66",
      "editor.wordHighlightStrongBorder": "#8BBEF4CC",
      "editorHoverWidget.background": "#252526",
      "editorHoverWidget.border": "#454545",
      "editorBracketMatch.background": "#0064001A",
      "editorBracketMatch.border": "#888888",
    },
  });
  monaco.editor.defineTheme("ace-paper", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "008000" },
      { token: "comment.doc", foreground: "4F8A10" },
      { token: "keyword", foreground: "0000FF" },
      { token: "keyword.control", foreground: "AF00DB" },
      { token: "annotation", foreground: "795E26" },
      { token: "attribute.name", foreground: "FF0000" },
      { token: "attribute.value", foreground: "A31515" },
      { token: "class-name", foreground: "267F99" },
      { token: "constant", foreground: "0070C1" },
      { token: "constructor", foreground: "795E26" },
      { token: "function", foreground: "795E26" },
      { token: "function.call", foreground: "795E26" },
      { token: "invalid", foreground: "CD3131" },
      { token: "key", foreground: "0451A5" },
      { token: "key.identifier", foreground: "0451A5" },
      { token: "namespace", foreground: "267F99" },
      { token: "regexp", foreground: "811F3F" },
      { token: "predefined", foreground: "AF00DB" },
      { token: "string", foreground: "A31515" },
      { token: "string.escape", foreground: "EE0000" },
      { token: "tag", foreground: "800000" },
      { token: "tag.name", foreground: "800000" },
      { token: "number", foreground: "098658" },
      { token: "type", foreground: "267F99" },
      { token: "type.identifier", foreground: "267F99" },
      { token: "variable", foreground: "7A3E9D" },
      { token: "variable.parameter", foreground: "001080" },
      { token: "delimiter", foreground: "000000" },
      { token: "delimiter.bracket", foreground: "000000" },
      { token: "operator", foreground: "000000" },
    ],
    colors: {
      "editor.background": "#FFFFFF",
      "editor.foreground": "#000000",
      "editor.lineHighlightBackground": "#F7F7F7",
      "editor.selectionBackground": "#ADD6FF",
      "editor.selectionHighlightBackground": "#C7DCF180",
      "editor.selectionHighlightBorder": "#5A91D633",
      "editor.inactiveSelectionBackground": "#E5EBF1",
      "editorCursor.foreground": "#000000",
      "editorWhitespace.foreground": "#D0D0D0",
      "editorIndentGuide.background1": "#D3D3D3",
      "editorIndentGuide.activeBackground1": "#939393",
      "editorLineNumber.foreground": "#237893",
      "editorLineNumber.activeForeground": "#0B216F",
      "editor.wordHighlightBackground": "#9CC2F04D",
      "editor.wordHighlightBorder": "#4A84CC99",
      "editor.wordHighlightStrongBackground": "#7BAEEB73",
      "editor.wordHighlightStrongBorder": "#2D6FB8CC",
      "editorHoverWidget.background": "#FFFFFF",
      "editorHoverWidget.border": "#C8CDD4",
      "editorBracketMatch.background": "#0064001A",
      "editorBracketMatch.border": "#B9B9B9",
    },
  });
  monacoConfigured = true;
}
